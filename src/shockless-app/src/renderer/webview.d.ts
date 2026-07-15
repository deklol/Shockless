import type React from "react";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        readonly src?: string;
        readonly partition?: string;
        readonly webpreferences?: string;
      };
    }
  }
}

export {};
