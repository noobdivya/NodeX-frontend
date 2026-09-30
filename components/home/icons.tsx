// Small inline icons (24×24, currentColor).
type P = { size?: number };

const svg = (size: number, path: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

export const BackIcon = ({ size = 24 }: P) => svg(size, <path d="M19 12H5M12 19l-7-7 7-7" />);

export const MoreIcon = ({ size = 24 }: P) =>
  svg(size, (
    <>
      <circle cx="12" cy="5" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="19" r="1.2" fill="currentColor" />
    </>
  ));

export const SearchIcon = ({ size = 24 }: P) =>
  svg(size, (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ));

export const AddPersonIcon = ({ size = 24 }: P) =>
  svg(size, (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6" />
    </>
  ));

export const CheckIcon = ({ size = 24 }: P) => svg(size, <path d="M20 6 9 17l-5-5" />);

export const PlusMessageIcon = ({ size = 24 }: P) =>
  svg(size, (
    <>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
      <path d="M13 9v6M10 12h6" />
    </>
  ));

export const CameraIcon = ({ size = 24 }: P) =>
  svg(size, (
    <>
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13.5" r="3.5" />
    </>
  ));

export const CloseIcon = ({ size = 24 }: P) => svg(size, <path d="M18 6 6 18M6 6l12 12" />);
