import styled from 'styled-components';

const StyledWrapper = styled.div`
  .title {
    font-size: ${(props) => props.theme.font.size.md};
  }

  .empty-state {
    padding: 48px 0;
  }
`;

export default StyledWrapper;
