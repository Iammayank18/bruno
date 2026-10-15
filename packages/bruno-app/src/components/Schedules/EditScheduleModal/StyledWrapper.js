import styled from 'styled-components';

const StyledWrapper = styled.div`
  font-size: ${(props) => props.theme.font.size.sm};

  .text-link {
    color: ${(props) => props.theme.textLink};
    white-space: nowrap;
  }

  .request-picker {
    .picker-toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .picker-list {
      max-height: 200px;
      overflow-y: auto;
      margin-top: 8px;
      border: 1px solid ${(props) => props.theme.border.border1};
      border-radius: ${(props) => props.theme.border.radius.sm};
    }

    .picker-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 5px 8px;
      cursor: pointer;

      &:hover {
        background-color: ${(props) => props.theme.plainGrid.hoverBg};
      }
    }
  }

  .variable-row {
    display: grid;
    grid-template-columns: 1fr 1.4fr auto auto;
    align-items: center;
    gap: 8px;
  }
`;

export default StyledWrapper;
