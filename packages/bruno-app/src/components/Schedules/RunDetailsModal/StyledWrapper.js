import styled from 'styled-components';

const StyledWrapper = styled.div`
  width: min(960px, 80vw);
  font-size: ${(props) => props.theme.font.size.sm};

  .section-title {
    margin-bottom: 6px;
    font-weight: 600;
  }

  .tab-panel {
    height: 380px;
    overflow-y: auto;
  }

  .error-block {
    max-height: 160px;
    overflow: auto;
    padding: 8px 10px;
    font-family: monospace;
    white-space: pre-wrap;
    word-break: break-all;
    border-radius: ${(props) => props.theme.border.radius.sm};
    color: ${(props) => props.theme.status.danger.text};
    background-color: ${(props) => props.theme.status.danger.background};
  }

  .headers-section + .headers-section {
    margin-top: 16px;
  }

  .body-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    border: 1px solid ${(props) => props.theme.border.border1};
    border-radius: ${(props) => props.theme.border.radius.sm};
    overflow: hidden;
  }

  .body-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 8px;
    border-bottom: 1px solid ${(props) => props.theme.border.border1};
  }

  .body-editor {
    flex: 1;
    min-height: 0;
  }

  .table-wrapper {
    border: 1px solid ${(props) => props.theme.table.border};
    border-radius: ${(props) => props.theme.border.radius.sm};
    overflow: hidden;
  }

  table {
    width: 100%;
    border-collapse: collapse;

    thead {
      color: ${(props) => props.theme.table.thead.color};
      font-weight: 500;

      td {
        border-top: none;
      }
    }

    td {
      border: 1px solid ${(props) => props.theme.table.border};
      padding: 4px 8px;

      &:first-child {
        border-left: none;
      }

      &:last-child {
        border-right: none;
      }

      &.value {
        word-break: break-all;
      }
    }

    tbody {
      tr:nth-child(odd) {
        background-color: ${(props) => props.theme.table.striped};
      }

      tr:last-child td {
        border-bottom: none;
      }
    }
  }

  .test-success {
    color: ${(props) => props.theme.colors.text.green};
  }

  .test-failure {
    color: ${(props) => props.theme.colors.text.danger};
  }

  .error-message {
    color: ${(props) => props.theme.colors.text.muted};
  }
`;

export default StyledWrapper;
