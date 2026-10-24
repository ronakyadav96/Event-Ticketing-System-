import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Router } from '@angular/router';
import { AuthService } from '../../../auth/auth.service';
import { environment } from '../../../../environments/environment';
import {
  BookingView,
  ChatMessage,
  ChatResponse,
  ConversationSummary,
  IDLE_BOOKING,
  StoredMessage,
} from '../models/chat.models';

const DEFAULT_PROMPTS = ['Show me movies', 'Comedy shows', 'Concerts', 'My bookings'];
const PICKER_STAGES = ['SELECT_VENUE', 'SELECT_DATE', 'SELECT_SHOWTIME'];
/** A booking a guest started; resumed automatically once they sign in. */
const PENDING_BOOKING_KEY = 'eventai_pending_booking';
const GUEST_ID_KEY = 'eventai_guest_id';
const TRUSTED_PAYMENT_PREFIX = 'https://checkout.stripe.com/';

/**
 * The single client-side source of truth for the AI chat.
 *
 * - Booking state is whatever the server last returned (`booking`); it is never built or
 *   modified locally, and it is reset whenever the user or the conversation changes.
 * - Every request captures an `epoch`; switching user/conversation bumps the epoch so late
 *   responses from the previous context are discarded instead of leaking into the new one.
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private router = inject(Router);
  private readonly api = environment.aiApiUrl;

  readonly isOpen = signal(false);
  readonly isExpanded = signal(false);
  readonly isSending = signal(false);
  readonly showHistory = signal(false);
  readonly unreadCount = signal(0);

  readonly messages = signal<ChatMessage[]>([]);
  readonly booking = signal<BookingView>(IDLE_BOOKING);
  readonly conversations = signal<ConversationSummary[]>([]);
  readonly currentConversationId = signal('');
  private readonly quickReplies = signal<string[]>(DEFAULT_PROMPTS);

  /** The current booking step offers venues/dates/times, rendered as a picker instead of chips. */
  readonly hasOptionPicker = computed(() => {
    const b = this.booking();
    const o = b.options || {};
    return PICKER_STAGES.includes(b.stage) && !!(o['venues']?.length || o['dates']?.length || o['times']?.length);
  });
  readonly currentQuickReplies = computed(() => {
    if (this.isSending() || this.hasOptionPicker()) return [];
    // The booking panel already offers confirm / pay / cancel; don't repeat them as chips.
    const panelOpen = ['REVIEW', 'PAYMENT_PENDING'].includes(this.booking().stage);
    return panelOpen
      ? this.quickReplies().filter((q) => !/proceed|cancel|completed the payment/i.test(q))
      : this.quickReplies();
  });
  readonly isTyping = computed(() => this.isSending());
  /** The payment button is shown only for an open, trusted Stripe checkout. */
  readonly paymentUrl = computed(() => {
    const b = this.booking();
    const url = b.payment?.payment_url;
    return b.stage === 'PAYMENT_PENDING' && url && url.startsWith(TRUSTED_PAYMENT_PREFIX) ? url : null;
  });

  private identityKey = '';
  private epoch = 0;
  private nextLocalId = 0;

  constructor() {
    effect(() => {
      this.auth.authVersion();
      untracked(() => this.syncIdentity());
    });
  }

  // ── Identity ────────────────────────────────────────────────────────────────

  private identity(): { key: string; headers: HttpHeaders } {
    const token = this.auth.getToken();
    const user = this.auth.getUser();
    if (token && user) {
      return {
        key: `user:${user.id || user._id}`,
        headers: new HttpHeaders({ Authorization: `Bearer ${token}` }),
      };
    }
    let guestId = localStorage.getItem(GUEST_ID_KEY);
    if (!guestId || !/^[A-Za-z0-9-]{16,64}$/.test(guestId)) {
      guestId = crypto.randomUUID();
      localStorage.setItem(GUEST_ID_KEY, guestId);
    }
    return { key: `guest:${guestId}`, headers: new HttpHeaders({ 'X-Guest-Id': guestId }) };
  }

  private activeConversationKey(): string {
    return `eventai_active_conversation:${this.identityKey}`;
  }

  /** Called on every auth change: a different identity never sees the previous one's chat. */
  syncIdentity(): void {
    const { key } = this.identity();
    if (key === this.identityKey) return;
    this.identityKey = key;
    this.epoch++;
    this.isSending.set(false);
    this.showHistory.set(false);
    this.conversations.set([]);

    const pending = this.auth.getToken() ? sessionStorage.getItem(PENDING_BOOKING_KEY) : null;
    if (pending) {
      // A guest asked to book, then signed in: continue that booking in a fresh chat.
      sessionStorage.removeItem(PENDING_BOOKING_KEY);
      this.startNewChat();
      this.isOpen.set(true);
      this.sendMessage(pending);
      return;
    }

    const saved = localStorage.getItem(this.activeConversationKey());
    if (saved) {
      this.loadConversation(saved);
    } else {
      this.startNewChat();
    }
  }

  // ── UI controls ─────────────────────────────────────────────────────────────

  toggle(): void {
    this.isOpen() ? this.close() : this.open();
  }

  open(): void {
    this.syncIdentity();
    this.isOpen.set(true);
    this.unreadCount.set(0);
    this.refreshState();
  }

  close(): void {
    this.isOpen.set(false);
  }

  toggleExpand(): void {
    this.isExpanded.update((v) => !v);
  }

  toggleHistory(open?: boolean): void {
    const next = open ?? !this.showHistory();
    this.showHistory.set(next);
    if (next) this.loadConversations();
  }

  // ── Conversations ───────────────────────────────────────────────────────────

  private welcome(): ChatMessage {
    const name = this.auth.getUser()?.name?.trim().split(' ')[0];
    return {
      id: 'welcome',
      role: 'assistant',
      text: `Hi${name ? ' ' + name : ''} 👋 I'm Event AI. Tell me what you'd like to watch — I'll find shows and book your seats.`,
      timestamp: new Date(),
    };
  }

  private enterConversation(id: string, persist = true): number {
    this.epoch++;
    this.currentConversationId.set(id);
    // A brand-new chat only exists on the server after its first message, so it is
    // remembered from then on (otherwise every page load would ask for a missing chat).
    if (persist) {
      localStorage.setItem(this.activeConversationKey(), id);
    } else {
      localStorage.removeItem(this.activeConversationKey());
    }
    this.messages.set([this.welcome()]);
    this.booking.set(IDLE_BOOKING);
    this.quickReplies.set(DEFAULT_PROMPTS);
    this.isSending.set(false);
    return this.epoch;
  }

  startNewChat(): void {
    // The server creates the conversation (owned by this identity) on its first message.
    this.enterConversation(`conv_${crypto.randomUUID().replace(/-/g, '')}`, false);
    this.showHistory.set(false);
  }

  loadConversations(): void {
    const { headers } = this.identity();
    const epoch = this.epoch;
    this.http.get<{ conversations: ConversationSummary[] }>(`${this.api}/conversations`, { headers }).subscribe({
      next: (res) => {
        if (epoch === this.epoch) this.conversations.set(res.conversations || []);
      },
      error: () => {
        if (epoch === this.epoch) this.conversations.set([]);
      },
    });
  }

  switchConversation(id: string): void {
    this.showHistory.set(false);
    if (id && id !== this.currentConversationId()) this.loadConversation(id);
  }

  private loadConversation(id: string): void {
    const epoch = this.enterConversation(id);
    const { headers } = this.identity();
    this.http
      .get<{ messages: StoredMessage[]; booking: BookingView }>(`${this.api}/conversations/${id}/messages`, { headers })
      .subscribe({
        next: (res) => {
          if (epoch !== this.epoch) return;
          const restored = (res.messages || []).map((m) => this.fromStored(m));
          this.messages.set(restored.length ? restored : [this.welcome()]);
          this.booking.set(res.booking || IDLE_BOOKING);
          const lastQuick = [...(res.messages || [])].reverse().find((m) => m.role === 'assistant')?.metadata?.['quick_replies'];
          this.quickReplies.set(lastQuick?.length ? lastQuick : DEFAULT_PROMPTS);
          this.refreshState();
        },
        error: (err: HttpErrorResponse) => {
          // 404: new (not yet created) or not ours — either way start clean.
          if (epoch === this.epoch && err.status !== 404) this.appendError('Could not load this conversation.');
        },
      });
  }

  deleteConversation(id: string): void {
    const { headers } = this.identity();
    this.http.delete(`${this.api}/conversations/${id}`, { headers }).subscribe({
      next: () => this.loadConversations(),
      error: () => this.loadConversations(),
    });
    this.conversations.update((list) => list.filter((c) => c.id !== id));
    if (id === this.currentConversationId()) this.startNewChat();
  }

  /** Re-reads authoritative booking/payment state (e.g. after returning from Stripe). */
  refreshState(): void {
    const id = this.currentConversationId();
    if (!id || this.messages().every((m) => m.id === 'welcome')) return;
    const epoch = this.epoch;
    const { headers } = this.identity();
    this.http
      .get<{ booking: BookingView; notice?: string | null }>(`${this.api}/conversations/${id}/state`, { headers })
      .subscribe({
        next: (res) => {
          if (epoch !== this.epoch) return;
          this.booking.set(res.booking || IDLE_BOOKING);
          if (res.notice) {
            this.messages.update((m) => [
              ...m,
              { id: `n${this.nextLocalId++}`, role: 'assistant', text: res.notice!, timestamp: new Date(), ticket: res.booking?.ticket },
            ]);
          }
        },
        error: () => undefined,
      });
  }

  // ── Messages ────────────────────────────────────────────────────────────────

  private fromStored(m: StoredMessage): ChatMessage {
    const meta = m.metadata || {};
    return {
      id: `s${m.id}`,
      role: m.role === 'user' ? 'user' : 'assistant',
      text: m.content,
      timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
      events: meta['events'] || undefined,
      ticket: meta['booking_stage'] === 'COMPLETED' ? meta['ticket'] : null,
      isError: !!meta['error'] && meta['error'] === 'INTERNAL_ERROR',
      action: meta['error'] === 'LOGIN_REQUIRED' ? 'login' : null,
    };
  }

  private appendError(text: string): void {
    this.messages.update((m) => [...m, { id: `e${this.nextLocalId++}`, role: 'assistant', text, timestamp: new Date(), isError: true }]);
  }

  sendMessage(prompt: string): void {
    const text = prompt.trim();
    if (!text || this.isSending()) return;
    this.syncIdentity();

    const epoch = this.epoch;
    const conversationId = this.currentConversationId();
    const { headers } = this.identity();
    const user = this.auth.getUser();

    this.messages.update((m) => [...m, { id: `u${this.nextLocalId++}`, role: 'user', text, timestamp: new Date() }]);
    this.isSending.set(true);

    this.http
      .post<ChatResponse>(
        `${this.api}/chat`,
        { message: text, conversation_id: conversationId, display_name: user?.name || undefined },
        { headers }
      )
      .subscribe({
        next: (res) => {
          if (epoch !== this.epoch) return; // user or conversation changed meanwhile
          this.isSending.set(false);
          localStorage.setItem(this.activeConversationKey(), conversationId);
          this.messages.update((m) => [
            ...m,
            {
              id: res.request_id,
              role: 'assistant',
              text: res.response,
              timestamp: new Date(),
              events: res.events?.length ? res.events : undefined,
              seatMap: res.seat_map || null,
              ticket: res.booking?.stage === 'COMPLETED' ? res.booking.ticket : null,
              isError: !!res.error && !['PAYMENT_UNAVAILABLE', 'LOGIN_REQUIRED'].includes(res.error),
              action: res.error === 'LOGIN_REQUIRED' ? 'login' : null,
            },
          ]);
          if (res.error === 'LOGIN_REQUIRED' && /^book\s/i.test(text)) {
            sessionStorage.setItem(PENDING_BOOKING_KEY, text);
          }
          this.booking.set(res.booking || IDLE_BOOKING);
          this.quickReplies.set(res.quick_replies?.length ? res.quick_replies : DEFAULT_PROMPTS);
          if (!this.isOpen()) this.unreadCount.update((c) => c + 1);
        },
        error: (err: HttpErrorResponse) => {
          if (epoch !== this.epoch) return;
          this.isSending.set(false);
          if (err.status === 401) {
            this.appendError('Your session has expired. Please log in again.');
          } else if (err.status === 409) {
            this.appendError('Still working on your previous message — please wait a moment.');
          } else if (err.status === 0) {
            this.appendError('⚠️ Unable to reach the Event AI service. Please check that it is running.');
          } else {
            this.appendError(err.error?.detail || 'Something went wrong. Please try again.');
          }
        },
      });
  }

  sendQuickReply(chip: string): void {
    this.sendMessage(chip);
  }

  goToLogin(): void {
    this.close();
    this.router.navigate(['/login']);
  }

  openPayment(): void {
    const url = this.paymentUrl();
    if (url) window.location.href = url;
  }
}
