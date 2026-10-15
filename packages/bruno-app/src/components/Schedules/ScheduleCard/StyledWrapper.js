import styled from 'styled-components';

const StyledWrapper = styled.div`
  padding: 12px 14px;
  border: 1px solid ${(props) => props.theme.border.border1};
  border-radius: ${(props) => props.theme.border.radius.md};

  .schedule-meta {
    display: flex;
    flex-wrap: wrap;
    column-gap: 6px;
    font-size: ${(props) => props.theme.font.size.sm};
    color: ${(props) => props.theme.colors.text.muted};

    span + span::before {
      content: '·';
      margin-right: 6px;
    }
  }

  .history-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: ${(props) => props.theme.font.size.sm};
    color: ${(props) => props.theme.colors.text.muted};

    &:hover {
      color: ${(props) => props.theme.text};
    }
  }
`;

export default StyledWrapper;
