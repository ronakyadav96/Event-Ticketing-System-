import { Component, Input } from '@angular/core';

export const BRAND = {
  name: 'Tamasha',
  tagline: 'Har din naya tamasha',
};

/** Tamasha logo: a gold jharokha arch with a spark, plus the wordmark. */
@Component({
  selector: 'app-brand-logo',
  standalone: true,
  template: `
    <span class="logo" [class.compact]="compact">
      <img class="mark" src="favicon.svg" alt="" aria-hidden="true" />
      <span class="words">
        <span class="name">{{ brand.name }}</span>
        @if (showTagline) {
          <span class="tagline">{{ brand.tagline }}</span>
        }
      </span>
    </span>
  `,
  styles: `
    .logo { display: inline-flex; align-items: center; gap: 10px; }
    .mark { width: 34px; height: 34px; flex-shrink: 0; filter: drop-shadow(0 2px 10px rgba(245, 165, 36, 0.35)); }
    .compact .mark { width: 28px; height: 28px; }
    .words { display: flex; flex-direction: column; line-height: 1; }
    .name {
      font-family: var(--font-display);
      font-size: 28px;
      line-height: 1.1;
      background: linear-gradient(180deg, #ffe2a3 0%, #f5a524 55%, #e2572b 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }
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
