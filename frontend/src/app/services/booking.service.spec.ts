import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';

import { BookingService } from './booking.service';

function fakeToken(expSecondsFromNow: number): string {
  const payload = btoa(JSON.stringify({ id: "u1", exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }));
  return `header.${payload}.signature`;
}

describe('BookingService refunds', () => {
  let service: BookingService;
  let backend: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('token', fakeToken(3600));
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(BookingService);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('asks the server for the refund quote with the auth token', () => {
    service.getRefundQuote('b1').subscribe();
    const req = backend.expectOne((r) => r.url === '/api/payments/refund-quote');
    expect(req.request.params.get('bookingId')).toBe('b1');
    expect(req.request.headers.get('Authorization')).toMatch(/^Bearer /);
    req.flush({ success: true, quote: {} });
  });

  it('cancels through the refund endpoint, never the delete endpoint', () => {
    service.cancelAndRefund('b1').subscribe();
    const req = backend.expectOne('/api/payments/refund');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ bookingId: 'b1' });
    req.flush({ success: true, status: 'REFUNDED' });
  });
});
