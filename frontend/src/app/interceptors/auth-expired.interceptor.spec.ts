import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpHeaders, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';

import { authExpiredInterceptor } from './auth-expired.interceptor';

function fakeToken(expSecondsFromNow: number): string {
  const payload = btoa(JSON.stringify({ id: "u1", exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }));
  return `header.${payload}.signature`;
}

describe('authExpiredInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let router: Router;
  const auth = { headers: new HttpHeaders({ Authorization: 'Bearer abc' }) };

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('token', fakeToken(3600));
    localStorage.setItem('user', JSON.stringify({ role: 'user' }));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([authExpiredInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
  });

  afterEach(() => backend.verify());

  it('signs out and redirects to login when the backend rejects the token', () => {
    http.get('/api/bookings', auth).subscribe({ error: () => undefined });
    backend.expectOne('/api/bookings').flush({ message: 'Invalid token' }, { status: 401, statusText: 'Unauthorized' });

    expect(localStorage.getItem('token')).toBeNull();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], expect.anything());
  });

  it('ignores 401 from the login endpoint (wrong password)', () => {
    http.post('/api/auth/login', {}).subscribe({ error: () => undefined });
    backend.expectOne('/api/auth/login').flush({}, { status: 401, statusText: 'Unauthorized' });

    expect(localStorage.getItem('token')).not.toBeNull();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('ignores other errors', () => {
    http.get('/api/bookings', auth).subscribe({ error: () => undefined });
    backend.expectOne('/api/bookings').flush({}, { status: 500, statusText: 'Server Error' });

    expect(localStorage.getItem('token')).not.toBeNull();
  });
});
