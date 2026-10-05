import { MODE_LABELS, MODES, type Mode } from "./modes";

interface Props {
  readonly mode: Mode;
  readonly onSelect: (mode: Mode) => void;
  readonly mac: boolean;
}

/**
 * The mode bar of PRD §6.3 (task 3.1): one button per mode, the current one pressed. Each button's
 * title names its chord; the chord itself is handled by the app, so it works wherever focus is.
 */
export default function ModeBar({ mode, onSelect, mac }: Props) {
  const chord = mac ? "⌘" : "Ctrl+";
  return (
    <nav className="mode-bar" data-testid="mode-bar" aria-label="Mode">
      {MODES.map((one, index) => (
        <button
          key={one}
          type="button"
          className="mode-button"
          data-testid={`mode-${one}`}
          aria-pressed={one === mode}
          title={`${MODE_LABELS[one]} (${chord}${index + 1})`}
          onClick={() => onSelect(one)}
        >
          {MODE_LABELS[one]}
        </button>
      ))}
    </nav>
  );
}
