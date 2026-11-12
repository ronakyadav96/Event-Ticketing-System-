import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';

/** Category-specific copy for the details page. */
const CATEGORY_LOOK: { match: string; icon: string; kicker: string; about: string }[] = [
  { match: 'comedy', icon: '🎤', kicker: 'Stand-up Comedy', about: 'An evening of non-stop laughs, fresh material and crowd work.' },
  { match: 'concert', icon: '🎶', kicker: 'Live Music', about: 'Live music, big sound and a crowd that sings along.' },
  { match: 'music', icon: '🎶', kicker: 'Live Music', about: 'Live music, big sound and a crowd that sings along.' },
  { match: 'sport', icon: '🏏', kicker: 'Sports', about: 'Feel the roar of the stadium — watch the action live.' },
  { match: 'play', icon: '🎭', kicker: 'Theatre', about: 'Stories come alive on stage.' },
  { match: 'workshop', icon: '🎨', kicker: 'Workshop', about: 'Learn hands-on and make something new.' },
  { match: 'seminar', icon: '🎓', kicker: 'Talk & Seminar', about: 'Hear directly from experts and learn something new.' },
  { match: 'activit', icon: '⛺', kicker: 'Experience', about: 'Make your weekend memorable.' },
];

@Component({
  standalone: true,
  selector: 'app-tamasha-template',
  imports: [CommonModule, DatePipe],
  templateUrl: './tamasha-template.component.html',
  styleUrls: ['./tamasha-template.component.css'],
})
export class TamashaTemplateComponent {
  @Input() event: any;
  @Input() eventImageUrl = '';
  @Input() eventImgFailed = false;
  @Input() isFreeEvent = false;
  @Input() unitPriceRupees = 0;
  @Output() openBooking = new EventEmitter<void>();

  get look() {
    const cat = String(this.event?.category || '').toLowerCase();
    return (
      CATEGORY_LOOK.find((c) => cat.includes(c.match)) || {
        icon: '✦',
        kicker: this.event?.category || 'Live Event',
        about: 'A memorable evening is waiting for you.',
      }
    );
  }

  get seatsLeft(): number | null {
    const total = Number(this.event?.totalSeats);
    if (!total) return null;
    return Math.max(0, total - Number(this.event?.bookedSeats || 0));
  }

  /** Multi-show events keep their first date; once it passes, shows are still running. */
  get isRunning(): boolean {
    const d = new Date(this.event?.date);
    return !isNaN(d.getTime()) && d.getTime() < Date.now();
  }

  onImgError() {
    this.eventImgFailed = true;
  }
}
