import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { EventCard } from '../../models/chat.models';
import { ChatService } from '../../services/chat.service';

const CATEGORY_LOOK: { match: string; tone: string; emoji: string }[] = [
  { match: 'movie', tone: 'tone-movie', emoji: '🎬' },
  { match: 'comedy', tone: 'tone-comedy', emoji: '😂' },
  { match: 'concert', tone: 'tone-music', emoji: '🎵' },
  { match: 'music', tone: 'tone-music', emoji: '🎵' },
  { match: 'sport', tone: 'tone-sports', emoji: '🏟️' },
  { match: 'play', tone: 'tone-theatre', emoji: '🎭' },
  { match: 'theatre', tone: 'tone-theatre', emoji: '🎭' },
  { match: 'workshop', tone: 'tone-learn', emoji: '🛠️' },
  { match: 'seminar', tone: 'tone-learn', emoji: '🎤' },
  { match: 'conference', tone: 'tone-learn', emoji: '🎤' },
];

@Component({
  selector: 'app-event-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './event-card.component.html',
  styleUrls: ['./event-card.component.scss'],
})
export class EventCardComponent {
  @Input({ required: true }) event!: EventCard;

  readonly chat = inject(ChatService);
  imageFailed = false;

  private get look() {
    const cat = (this.event.category || '').toLowerCase();
    return CATEGORY_LOOK.find((c) => cat.includes(c.match)) || { tone: 'tone-default', emoji: '🎟️' };
  }

  get tone(): string {
    return this.look.tone;
  }

  get emoji(): string {
    return this.look.emoji;
  }

  // The assistant resolves the title against the events it has already shown (by id).
  onBookClick(): void {
    this.chat.sendMessage(`Book ${this.event.title}`);
  }

  onDetailsClick(): void {
    this.chat.sendMessage(`Tell me more about ${this.event.title}`);
  }
}
