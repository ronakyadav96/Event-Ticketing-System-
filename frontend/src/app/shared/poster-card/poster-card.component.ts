import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { EventService } from '../../services/event.service';

/**
 * BookMyShow-style portrait card: poster with a date (events) or rating (movies) strip,
 * then title, venue and price. Links to the event details page.
 */
@Component({
  selector: 'app-poster-card',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './poster-card.component.html',
  styleUrls: ['./poster-card.component.css'],
})
export class PosterCardComponent {
  @Input({ required: true }) event!: any;

  private es = inject(EventService);
  imageFailed = false;

  get id(): string {
    return String(this.event?._id || this.event?.id || '');
  }

  get image(): string {
    return this.es.getEventImageUrl(this.event);
  }

  get isMovie(): boolean {
    return /^movies?$/i.test(String(this.event?.category || ''));
  }

  get rating(): number | null {
    const r = Number(this.event?.movieMeta?.voteAverage ?? this.event?.rating);
    return Number.isFinite(r) && r > 0 ? r : null;
  }

  get isPast(): boolean {
    const end = new Date(this.event?.endDate || this.event?.date || 0);
    end.setUTCHours(23, 59, 59, 999);
    return end.getTime() < Date.now();
  }

  /** "Sat, 25 Oct onwards" — the next day the event runs (today if it has already started). */
  get dateLabel(): string {
    if (this.isPast) return 'Event ended';
    const start = new Date(this.event?.startDate || this.event?.date || 0);
    const end = new Date(this.event?.endDate || this.event?.startDate || this.event?.date || 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const next = start.getTime() < today.getTime() ? today : start;
    const fmt = (d: Date) => d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    const multiDay = end.toDateString() !== next.toDateString();
    return `${fmt(next)}${multiDay ? ' onwards' : ''}`;
  }

  get place(): string {
    return [this.event?.venue, this.event?.city].filter(Boolean).join(': ');
  }

  get priceLabel(): string {
    const p = Number(this.event?.price);
    if (!Number.isFinite(p)) return '';
    return p === 0 ? 'Free' : `₹${p.toLocaleString('en-IN')} onwards`;
  }
}
