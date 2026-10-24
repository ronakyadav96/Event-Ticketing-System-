import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChatService } from '../../services/chat.service';

/**
 * The one place the active booking is shown. It renders the server's booking state only:
 * the payment button exists only while Node reports an open Stripe checkout.
 */
@Component({
  selector: 'app-booking-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './booking-panel.component.html',
  styleUrls: ['./booking-panel.component.scss'],
})
export class BookingPanelComponent {
  readonly chat = inject(ChatService);
  readonly booking = this.chat.booking;
  readonly visible = computed(() => ['REVIEW', 'PAYMENT_PENDING'].includes(this.booking().stage) && !!this.booking().event);

  pay(): void {
    this.chat.openPayment();
  }

  cancel(): void {
    this.chat.sendMessage('Cancel this booking');
  }

  checkPaid(): void {
    this.chat.sendMessage("I've completed the payment");
  }

  confirm(): void {
    this.chat.sendMessage('Yes, confirm and proceed to payment');
  }
}
