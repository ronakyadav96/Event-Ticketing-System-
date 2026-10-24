import { Component, OnInit, OnDestroy, inject, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { HttpClient, HttpClientModule, HttpHeaders } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../auth/auth.service';
import { ChatService } from '../../components/chat/services/chat.service';

export type PaymentStatusStage = 'INITIATING' | 'VERIFYING' | 'SUCCESS' | 'PENDING' | 'ERROR';

@Component({
  standalone: true,
  imports: [CommonModule, HttpClientModule, RouterModule],
  selector: 'app-payment-success',
  templateUrl: './payment-success.component.html',
  styleUrls: ['./payment-success.component.css'],
})
export class PaymentSuccessComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private http = inject(HttpClient);
  private cdr = inject(ChangeDetectorRef);
  private auth = inject(AuthService);
  private chat = inject(ChatService);

  sessionId = '';
  stage: PaymentStatusStage = 'INITIATING';
  ticketId = '';
  errorMessage = '';
  countdownSeconds = 2;

  // Single-request control: eliminates network tab polling spam
  isVerifying = false;
  private autoRetryCount = 0;
  private readonly MAX_AUTO_RETRIES = 1; // Maximum 1 gentle follow-up if strictly pending
  private timer: any = null;
  private countdownTimer: any = null;

  // Backend API URL
  private API_BASE = `${environment.apiUrl}/api`;

  ngOnInit(): void {
    this.sessionId = this.route.snapshot.queryParamMap.get('session_id') || '';

    if (!this.sessionId) {
      this.stage = 'ERROR';
      this.errorMessage = 'No session ID found. Cannot verify payment.';
      return;
    }

    // Step 1: Show "Payment Initiated", then immediately send exactly 1 single verification request
    this.stage = 'INITIATING';
    this.timer = setTimeout(() => {
      this.verifyPayment();
    }, 350);
  }

  ngOnDestroy(): void {
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  verifyPayment(): void {
    if (!this.sessionId || this.isVerifying) return;

    this.clearTimers();
    this.isVerifying = true;
    this.stage = 'VERIFYING';
    this.errorMessage = '';
    this.cdr.markForCheck();

    const token = this.auth.getToken();
    if (!token) {
      this.isVerifying = false;
      this.stage = 'ERROR';
      this.errorMessage = 'Please log in to verify your payment.';
      this.cdr.markForCheck();
      return;
    }

    // Owner-only endpoint: Node checks the order belongs to this user and asks Stripe for the
    // real payment status. Only status PAID with a ticket ID means the booking exists.
    this.http
      .get<{ success: boolean; status: string; ticketId?: string | null; message?: string; failureReason?: string | null }>(
        `${this.API_BASE}/payments/orders/${encodeURIComponent(this.sessionId)}`,
        { headers: new HttpHeaders({ Authorization: `Bearer ${token}` }) }
      )
      .subscribe({
        next: (res) => {
          this.isVerifying = false;
          if (res?.status === 'PAID' && res.ticketId) {
            this.stage = 'SUCCESS';
            this.ticketId = res.ticketId;
            this.chat.refreshState();
            this.startRedirectCountdown();
            this.cdr.markForCheck();
            return;
          }
          if (res?.status === 'PENDING') {
            this.stage = 'PENDING';
            if (this.autoRetryCount < this.MAX_AUTO_RETRIES) {
              this.autoRetryCount += 1;
              this.timer = setTimeout(() => this.verifyPayment(), 4000);
            }
            this.cdr.markForCheck();
            return;
          }
          this.stage = 'ERROR';
          this.errorMessage =
            res?.failureReason || res?.message || `Payment was not completed (status: ${res?.status || 'unknown'}). No booking was created.`;
          this.chat.refreshState();
          this.cdr.markForCheck();
        },
        error: (err) => {
          this.isVerifying = false;
          this.stage = 'ERROR';
          this.errorMessage = err?.error?.message || 'Could not verify the payment right now. Please check My Bookings shortly.';
          this.cdr.markForCheck();
        },
      });
  }

  startRedirectCountdown(): void {
    this.countdownSeconds = 2;
    this.countdownTimer = setInterval(() => {
      this.countdownSeconds -= 1;
      this.cdr.markForCheck();
      if (this.countdownSeconds <= 0) {
        this.clearTimers();
        this.goToTicket();
      }
    }, 1000);
  }

  goToTicket(): void {
    this.clearTimers();
    if (this.ticketId) {
      this.router.navigate(['/booking', this.ticketId]);
    } else {
      this.router.navigate(['/history']);
    }
  }

  goToEvents(): void {
    this.clearTimers();
    this.router.navigate(['/events']);
  }

  goToHistory(): void {
    this.clearTimers();
    this.router.navigate(['/history']);
  }
}
