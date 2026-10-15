const _ = require('lodash');
const Store = require('electron-store');
const { valueToString } = require('@usebruno/common/utils');
const { encryptStringSafe, decryptStringSafe } = require('../utils/encryption');
const { uuid } = require('../utils/common');

const DEFAULT_RETENTION = 100;
const MAX_RETENTION = 1000;

const posixifyPath = (p) => (p ? p.replace(/\\/g, '/') : p);

// Relative to the collection and posixified; an empty selection means every request.
const normalizeRequestPaths = (requestPaths) => {
  if (!_.isArray(requestPaths)) {
    return null;
  }
  const normalized = _.uniq(requestPaths.filter(_.isString).map((p) => posixifyPath(p.trim())).filter(Boolean)).sort();
  return normalized.length > 0 ? normalized : null;
};

/**
 * Schedule definitions are user-authored app settings, so they live in electron-store
 * rather than in collection files or SQLite (which only holds the derived run history).
 * Secret variable values and webhook headers are encrypted at rest; secret values are
 * decrypted only inside the main process when a run starts.
 */
class SchedulesStore {
  constructor() {
    this.store = new Store({
      name: 'schedules',
      clearInvalidConfig: true
    });
  }

  getAll() {
    return this.store.get('schedules') || [];
  }

  getByCollectionPath(collectionPath) {
    const normalizedPath = posixifyPath(collectionPath);
    return this.getAll()
      .filter((schedule) => posixifyPath(schedule.collectionPath) === normalizedPath)
      .map((schedule) => this.redact(schedule));
  }

  get(scheduleId) {
    return this.getAll().find((schedule) => schedule.id === scheduleId);
  }

  validate({ name, collectionPath, cron, retention, variables }) {
    if (!_.isString(name) || !name.trim()) {
      throw new Error('Schedule name is required');
    }
    if (!_.isString(collectionPath) || !collectionPath.trim()) {
      throw new Error('Schedule collection path is required');
    }
    if (!_.isString(cron) || !cron.trim()) {
      throw new Error('Schedule cron expression is required');
    }
    if (retention !== undefined && (!_.isInteger(retention) || retention < 1 || retention > MAX_RETENTION)) {
      throw new Error(`Schedule retention must be an integer between 1 and ${MAX_RETENTION}`);
    }
    if (variables !== undefined && !_.isArray(variables)) {
      throw new Error('Schedule variables must be an array');
    }
  }

  create({ name, collectionPath, folderPath = null, recursive = true, environment = null, cron, variables = [], requestPaths = null, notify = {}, retention = DEFAULT_RETENTION, enabled = true }) {
    this.validate({ name, collectionPath, cron, retention, variables });

    const now = Date.now();
    const schedule = {
      id: `schedule_${uuid()}`,
      name: name.trim(),
      collectionPath,
      folderPath: folderPath || null,
      recursive: recursive !== false,
      environment: environment || null,
      cron: cron.trim(),
      requestPaths: normalizeRequestPaths(requestPaths),
      variables: this.encryptVariables(variables),
      notify: this.encryptNotify(notify),
      retention,
      enabled: enabled !== false,
      createdAt: now,
      updatedAt: now
    };

    const schedules = this.getAll();
    schedules.push(schedule);
    this.store.set('schedules', schedules);
    return this.redact(schedule);
  }

  update(scheduleId, updates) {
    const schedules = this.getAll();
    const schedule = schedules.find((s) => s.id === scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    const merged = { ...schedule, ..._.pick(updates, ['name', 'folderPath', 'recursive', 'environment', 'cron', 'retention', 'enabled']) };
    this.validate(merged);
    merged.name = merged.name.trim();
    merged.cron = merged.cron.trim();

    if (updates.requestPaths !== undefined) {
      merged.requestPaths = normalizeRequestPaths(updates.requestPaths);
    }
    if (updates.variables !== undefined) {
      if (!_.isArray(updates.variables)) {
        throw new Error('Schedule variables must be an array');
      }
      merged.variables = this.encryptVariables(updates.variables, schedule.variables);
    }
    if (updates.notify !== undefined) {
      merged.notify = this.encryptNotify({ ...this.decryptNotify(schedule.notify), ...updates.notify });
    }

    merged.updatedAt = Date.now();
    _.assign(schedule, merged);
    this.store.set('schedules', schedules);
    return this.redact(schedule);
  }

  delete(scheduleId) {
    const schedules = this.getAll();
    const remaining = schedules.filter((s) => s.id !== scheduleId);
    if (remaining.length === schedules.length) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    this.store.set('schedules', remaining);
  }

  encryptVariables(variables, previous = []) {
    return (variables || []).map((variable) => {
      const entry = {
        name: variable.name,
        value: '',
        secret: Boolean(variable.secret),
        enabled: variable.enabled !== false
      };

      const previousEntry = previous.find((v) => v.name === variable.name && v.secret);
      // The renderer never receives stored secret values, so a blank secret means "keep it".
      if (entry.secret && (variable.value === '' || variable.value === undefined) && previousEntry) {
        entry.value = previousEntry.value;
      } else if (variable.value !== '' && variable.value !== undefined && variable.value !== null) {
        entry.value = entry.secret ? encryptStringSafe(valueToString(variable.value)).value : valueToString(variable.value);
      }

      return entry;
    });
  }

  decryptVariables(variables = []) {
    return variables.map((variable) => {
      if (!variable.secret) {
        return variable;
      }
      const value = variable.value ? decryptStringSafe(variable.value).value : '';
      return { ...variable, value };
    });
  }

  encryptNotify(notify = {}) {
    let headers = notify.webhookHeaders;
    if (typeof headers === 'string') {
      try {
        headers = JSON.parse(headers);
      } catch (error) {
        throw new Error('Webhook headers must be a JSON object');
      }
    }

    return {
      os: notify.os !== false,
      webhookUrl: notify.webhookUrl || null,
      webhookHeaders: _.isPlainObject(headers) && !_.isEmpty(headers) ? encryptStringSafe(JSON.stringify(headers)).value : null
    };
  }

  decryptNotify(notify = {}) {
    if (!notify.webhookHeaders) {
      return { ...notify, webhookHeaders: {} };
    }
    try {
      return { ...notify, webhookHeaders: JSON.parse(decryptStringSafe(notify.webhookHeaders).value || '{}') };
    } catch (error) {
      console.error('[schedules] failed to decrypt webhook headers', error);
      return { ...notify, webhookHeaders: {} };
    }
  }

  // Secret variable values never leave the main process; webhook headers are decrypted
  // because the user edits them in the schedule form.
  redact(schedule) {
    return {
      ...schedule,
      variables: (schedule.variables || []).map((variable) =>
        variable.secret ? { ...variable, value: undefined, hasValue: Boolean(variable.value) } : variable
      ),
      notify: this.decryptNotify(schedule.notify)
    };
  }
}

let instance = null;
// electron-store doesn't watch its file, so every caller must share one instance.
const getSchedulesStore = () => {
  if (!instance) {
    instance = new SchedulesStore();
  }
  return instance;
};

module.exports = { SchedulesStore, getSchedulesStore };
