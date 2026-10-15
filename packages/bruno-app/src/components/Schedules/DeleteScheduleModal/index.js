import React from 'react';
import { useDispatch } from 'react-redux';
import toast from 'react-hot-toast';
import Portal from 'components/Portal';
import Modal from 'components/Modal';
import { deleteSchedule } from 'providers/ReduxStore/slices/schedules';

const DeleteScheduleModal = ({ collection, schedule, onClose }) => {
  const dispatch = useDispatch();

  const handleConfirm = () => {
    dispatch(deleteSchedule({ collectionPath: collection.pathname, scheduleId: schedule.id }))
      .unwrap()
      .then(() => {
        toast.success('Schedule deleted');
        onClose();
      })
      .catch((err) => toast.error(err.message || 'Failed to delete schedule'));
  };

  return (
    <Portal>
      <Modal
        size="sm"
        title="Delete Schedule"
        confirmText="Delete"
        confirmButtonColor="danger"
        handleConfirm={handleConfirm}
        handleCancel={onClose}
        dataTestId="delete-schedule-modal"
      >
        Are you sure you want to delete <span className="font-medium">{schedule.name}</span>? Its run history is deleted too.
      </Modal>
    </Portal>
  );
};

export default DeleteScheduleModal;
