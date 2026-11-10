import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from '../auth/auth.service';
import {
  Booking,
  CreateBookingPayload,
  CheckoutSessionPayload,
  CheckoutSessionResponse,
  BookingsPagedResponse,
} from '../models/booking.model';

@Injectable({
  providedIn: 'root',
})
export class BookingService {
  private readonly API = `${environment.apiUrl}/api/bookings`;
  private readonly PAYMENTS_API = `${environment.apiUrl}/api/payments`;

  constructor(
    private http: HttpClient,
    private authService: AuthService
  ) {}

  private getAuthHeaders(): { headers: HttpHeaders } {
    const token = this.authService.getToken();
    return {
      headers: new HttpHeaders({
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }),
    };
  }

  createBooking(data: CreateBookingPayload): Observable<Booking> {
    return this.http.post<Booking>(this.API, data, this.getAuthHeaders());
  }

  addBooking(data: CreateBookingPayload): Observable<Booking> {
    return this.createBooking(data);
  }

  createCheckoutSession(data: CheckoutSessionPayload): Observable<CheckoutSessionResponse> {
    return this.http.post<CheckoutSessionResponse>(
      `${this.PAYMENTS_API}/create-checkout-session`,
      data,
      this.getAuthHeaders()
    );
  }

  createStripeCheckout(data: CheckoutSessionPayload): Observable<CheckoutSessionResponse> {
    return this.createCheckoutSession(data);
  }

  getByTicketId(ticketId: string): Observable<Booking> {
    return this.http.get<Booking>(`${this.API}/ticket/${encodeURIComponent(ticketId)}`, this.getAuthHeaders());
  }

  getMyBookings(): Observable<Booking[]> {
    return this.http.get<Booking[]>(`${this.API}/my`, this.getAuthHeaders());
  }

  getAllBookings(params?: { page?: number; limit?: number }): Observable<BookingsPagedResponse> {
    let httpParams = new HttpParams();
    if (params?.page) httpParams = httpParams.set('page', String(params.page));
    if (params?.limit) httpParams = httpParams.set('limit', String(params.limit));

    return this.http.get<BookingsPagedResponse>(this.API, {
      ...this.getAuthHeaders(),
      params: httpParams,
    });
  }

  deleteBooking(id: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`${this.API}/${encodeURIComponent(id)}`, this.getAuthHeaders());
  }

  /** Server-side refund policy evaluation for a paid booking (nothing is changed). */
  getRefundQuote(bookingId: string): Observable<RefundQuoteResponse> {
    return this.http.get<RefundQuoteResponse>(`${this.PAYMENTS_API}/refund-quote`, {
      ...this.getAuthHeaders(),
      params: new HttpParams().set('bookingId', bookingId),
    });
  }

  /** Cancels a paid booking and refunds the policy amount. */
  cancelAndRefund(bookingId: string): Observable<RefundResponse> {
    return this.http.post<RefundResponse>(`${this.PAYMENTS_API}/refund`, { bookingId }, this.getAuthHeaders());
  }
}

export interface RefundQuote {
  eligible: boolean;
  refundPercent: number;
  refundAmount: number; // smallest currency unit (paise)
  amountPaid: number;
  currency: string;
  reason: string | null;
}

export interface RefundQuoteResponse {
  success: boolean;
  quote: RefundQuote;
}

export interface RefundResponse {
  success: boolean;
  status: string;
  message?: string;
  booking?: { paymentStatus: string; refundAmount?: number; refundStatus?: string | null };
}
