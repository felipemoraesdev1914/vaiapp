import { CircleHelp, MapPinned } from 'lucide-react';

export function BrandHeader({ onAbout }: { onAbout: () => void }) {
  return (
    <header className="topbar">
      <div className="brand" aria-label="VAI Mobilidade Inteligente">
        <span className="brand-mark"><MapPinned size={21} strokeWidth={2.4} /></span>
        <span>
          <span className="brand-name">VAI</span>
          <span className="brand-sub">Mobilidade inteligente</span>
        </span>
      </div>
      <div className="topbar-right">
        <div className="service-status"><span className="status-dot" /> Planejamento em Barueri, SP</div>
        <button className="help-button" type="button" aria-label="Sobre esta demonstração" title="Sobre esta demonstração" onClick={onAbout} data-testid="button-about">
          <CircleHelp size={18} />
        </button>
      </div>
    </header>
  );
}
