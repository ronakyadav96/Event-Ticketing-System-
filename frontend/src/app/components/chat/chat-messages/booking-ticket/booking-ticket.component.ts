import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

/** Rendered only for tickets the server reports as COMPLETED (payment verified by Stripe/Node). */
export interface TicketCardData {
  ticketId: string;
  eventName?: string | null;
  venue?: string | null;
  showAt?: string | null;
  seats?: string[];
  amountPaise?: number | null;
}

@Component({
  selector: 'app-booking-ticket',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './booking-ticket.component.html',
  styleUrls: ['./booking-ticket.component.scss'],
})
export class BookingTicketComponent {
  @Input({ required: true }) ticket!: TicketCardData;
}
