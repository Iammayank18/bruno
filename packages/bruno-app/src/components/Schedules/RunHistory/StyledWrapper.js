import styled from 'styled-components';

const StyledWrapper = styled.div`
  font-size: ${(props) => props.theme.font.size.sm};

  table {
    width: 100%;
    border-collapse: collapse;

    thead td {
      padding: 6px 8px;
      color: ${(props) => props.theme.table.thead.color};
      border-bottom: 1px solid ${(props) => props.theme.table.border};
      user-select: none;
    }

    tbody td {
      padding: 6px 8px;
      border-bottom: 1px solid ${(props) => props.theme.table.border};
      vertical-align: middle;
    }
  }

  .run-row {
    cursor: pointer;

    &:hover,
    &.active {
      background-color: ${(props) => props.theme.plainGrid.hoverBg};
    }
  }

  .run-requests {
    padding: 2px 0 4px 8px;
  }

  .run-request {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    padding: 4px 6px;
    text-align: left;
    border-radius: ${(props) => props.theme.border.radius.sm};

    &:hover {
      background-color: ${(props) => props.theme.background.surface0};
    }
  }

  .test-success {
    color: ${(props) => props.theme.colors.text.green};
  }

  .test-failure {
    color: ${(props) => props.theme.colors.text.danger};
  }
`;

export default StyledWrapper;
