import {
  Component,
  ElementRef,
  ViewChild,
  AfterViewChecked,
  computed,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatService } from '../services/chat.service';
import { AuthService } from '../../../auth/auth.service';
import { MessageBubbleComponent } from './message-bubble/message-bubble.component';
import { EventCardComponent } from './event-card/event-card.component';
import { BookingTicketComponent, TicketCardData } from './booking-ticket/booking-ticket.component';
import { BookingPanelComponent } from './booking-panel/booking-panel.component';
import { SeatMapComponent } from './seat-map/seat-map.component';
import { BookingStage, ChatMessage } from '../models/chat.models';

interface StarterTile {
  emoji: string;
  label: string;
  prompt: string;
}

interface DateOption {
  iso: string;
  weekday: string;
  day: string;
  month: string;
  /** Sent to the assistant; matches the server's own date format ("Mon, 05 Oct 2026"). */
  value: string;
}

const STEPS: { label: string; stages: BookingStage[] }[] = [
  { label: 'Date', stages: ['SELECT_VENUE', 'SELECT_DATE'] },
  { label: 'Time', stages: ['SELECT_SHOWTIME'] },
  { label: 'Tickets', stages: ['SELECT_QUANTITY'] },
  { label: 'Seats', stages: ['SELECT_SEATS'] },
  { label: 'Review', stages: ['REVIEW'] },
  { label: 'Pay', stages: ['PAYMENT_PENDING'] },
];

@Component({
  selector: 'app-chat-messages',
  standalone: true,
  imports: [
    CommonModule,
    MessageBubbleComponent,
    EventCardComponent,
    BookingTicketComponent,
    BookingPanelComponent,
    SeatMapComponent,
  ],
  templateUrl: './chat-messages.component.html',
  styleUrls: ['./chat-messages.component.scss'],
})
export class ChatMessagesComponent implements AfterViewChecked {
  readonly chat = inject(ChatService);
  private auth = inject(AuthService);

  @ViewChild('scrollContainer') private scrollContainer!: ElementRef<HTMLDivElement>;

  readonly starters: StarterTile[] = [
    { emoji: '😂', label: 'Comedy this weekend', prompt: 'Is weekend comedy shows dikhao' },
    { emoji: '🎵', label: 'Concerts', prompt: 'Show me concerts' },
    { emoji: '🏏', label: 'Sports', prompt: 'Koi sports event hai kya?' },
    { emoji: '🎬', label: 'Movies', prompt: 'Show me movies' },
    { emoji: '🎨', label: 'Workshops', prompt: 'Workshops near me' },
    { emoji: '↩️', label: 'Refund policy', prompt: 'What is the cancellation and refund policy?' },
  ];

  viewLabel(msg: ChatMessage): string {
    const v = msg.view;
    if (!v) return '';
    if (v.type === 'explore') return 'View results';
    return v.action === 'book' ? 'Open booking' : 'Open event';
  }

  readonly steps = STEPS.map((s) => s.label);

  /** Index of the current booking step, or -1 when no booking is in progress. */
  readonly stepIndex = computed(() => {
    const stage = this.chat.booking().stage;
    return STEPS.findIndex((s) => s.stages.includes(stage));
  });

  readonly isWelcome = computed(() => this.chat.messages().every((m) => m.id === 'welcome'));

  readonly dateOptions = computed<DateOption[]>(() =>
    ((this.chat.booking().options?.['dates'] as string[]) || []).slice(0, 14).map((iso) => {
      const d = new Date(`${iso}T00:00:00Z`);
      const part = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-GB', { ...o, timeZone: 'UTC' });
      const weekday = part({ weekday: 'short' });
      const day = String(d.getUTCDate()).padStart(2, '0');
      const month = part({ month: 'short' });
      return { iso, weekday, day, month, value: `${weekday}, ${day} ${month} ${d.getUTCFullYear()}` };
    })
  );

  readonly timeOptions = computed(() =>
    ((this.chat.booking().options?.['times'] as string[]) || []).map((hhmm) => {
      const [h, m] = hhmm.split(':').map(Number);
      const label = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
      return { hhmm, label };
    })
  );

  readonly venueOptions = computed(() => (this.chat.booking().options?.['venues'] as string[]) || []);

  private previousMsgCount = 0;
  private previousIsTyping = false;
  private userScrolledUp = false;

  onScroll(): void {
    const el = this.scrollContainer?.nativeElement;
    if (!el) return;
    this.userScrolledUp = el.scrollHeight - el.scrollTop - el.clientHeight > 80;
  }

  ngAfterViewChecked(): void {
    const count = this.chat.messages().length;
    const typing = this.chat.isTyping();
    if (count !== this.previousMsgCount || typing !== this.previousIsTyping) {
      const added = count !== this.previousMsgCount;
      this.previousMsgCount = count;
      this.previousIsTyping = typing;
      if (added || !this.userScrolledUp) this.scrollToBottom();
    }
  }

  private latestAssistant(): ChatMessage | undefined {
    return [...this.chat.messages()].reverse().find((m) => m.role === 'assistant');
  }

  /** Interactive pickers belong to the latest assistant turn only, while nothing is in flight. */
  isLatest(msg: ChatMessage): boolean {
    return msg === this.latestAssistant() && !this.chat.isSending();
  }

  showSeatMap(msg: ChatMessage): boolean {
    return !!msg.seatMap && this.isLatest(msg) && this.chat.booking().stage === 'SELECT_SEATS';
  }

  showPicker(msg: ChatMessage): boolean {
    return this.isLatest(msg) && this.chat.hasOptionPicker();
  }

  seatsRequired(): number {
    return Math.max(0, this.chat.booking().quantity || 0);
  }

  isSignedIn(): boolean {
    return !!this.auth.getToken();
  }

  pick(value: string): void {
    this.chat.sendMessage(value);
  }

  cancelBooking(): void {
    this.chat.sendMessage('Cancel booking');
  }

  ticketCard(msg: ChatMessage): TicketCardData | null {
    if (!msg.ticket?.ticket_id) return null;
    const b = this.chat.booking();
    // Full details are known for the current booking; older transcript tickets show the ID only.
    if (b.stage === 'COMPLETED' && b.ticket?.ticket_id === msg.ticket.ticket_id) {
      return {
        ticketId: b.ticket.ticket_id,
        eventName: b.event?.title,
        venue: b.event?.venue,
        showAt: b.show_at,
        seats: b.seats,
        amountPaise: b.payment?.amount_total ?? null,
      };
    }
    return { ticketId: msg.ticket.ticket_id };
  }

  scrollToBottom(): void {
    const el = this.scrollContainer?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }

  scrollCards(row: HTMLElement, direction: 1 | -1): void {
    row.scrollBy({ left: direction * row.clientWidth * 0.8, behavior: 'smooth' });
  }
}
