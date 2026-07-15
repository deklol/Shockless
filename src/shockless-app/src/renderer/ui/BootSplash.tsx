interface BootSplashProps {
  readonly booting: boolean;
}

export function BootSplash({ booting }: BootSplashProps) {
  return (
    <div className={`boot-splash ${booting ? "" : "boot-hide"}`} aria-hidden={!booting}>
      <div className="boot-inner">
        <div className="boot-brand">
          <img className="boot-sprite" src="./img/headicon.png" alt="" aria-hidden="true" />
          <span className="boot-title">Shockless Engine</span>
        </div>
        <div className="boot-bar">
          <span />
        </div>
      </div>
    </div>
  );
}
