import { Component, Input } from '@angular/core';

export const BRAND = {
  name: 'Tamasha',
  tagline: 'Har din naya tamasha',
};

/** Tamasha logo: a serif wordmark with a champagne full stop. */
@Component({
  selector: 'app-brand-logo',
  standalone: true,
  template: `
    <span class="logo" [class.compact]="compact">
      <span class="words">
        <span class="name">{{ brand.name }}<span class="dot">.</span></span>
        @if (showTagline) {
          <span class="tagline">{{ brand.tagline }}</span>
        }
      </span>
    </span>
  `,
  styles: `
    .logo { display: inline-flex; align-items: center; }
    .words { display: flex; flex-direction: column; line-height: 1; }
    .name {
      font-family: var(--font-display);
      font-weight: 700;
      font-size: 27px;
      line-height: 1.1;
      letter-spacing: -0.01em;
      color: var(--text-primary);
    }
    .dot { color: var(--brand-primary); }
    .compact .name { font-size: 22px; }
    .tagline {
      margin-top: 1px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--text-muted);
      white-space: nowrap;
    }
  `,
})
export class BrandLogoComponent {
  @Input() compact = false;
  @Input() showTagline = true;
  protected readonly brand = BRAND;
}
