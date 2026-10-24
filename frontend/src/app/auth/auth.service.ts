import { Injectable, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';

import { environment } from '../../environments/environment';

export interface User {
  id?: string;
  _id?: string;
  name: string;
  email: string;
  role: 'user' | 'creator' | 'superadmin';
  isVerified?: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {

  private readonly apiUrl = `${environment.apiUrl}/api/auth`;

  private readonly TOKEN_KEY = 'token';
  private readonly USER_KEY = 'user';

  /** Increments whenever the signed-in identity may have changed (login, logout, other tab). */
  readonly authVersion = signal(0);

  constructor(
    private http: HttpClient,
    private router: Router
  ) {
    window.addEventListener('storage', (e) => {
      if (e.key === this.TOKEN_KEY || e.key === this.USER_KEY || e.key === null) {
        this.authVersion.update((v) => v + 1);
      }
    });
  }

  // 🔐 LOGIN
  login(email: string, password: string) {
    return this.http.post<{ token: string; user: User }>(
      `${this.apiUrl}/login`,
      {
        email: (email || '').trim().toLowerCase(),
        password: (password || '').trim(),
      }
    );
  }

  // 📝 REGISTER
  register(name: string, email: string, password: string, role: string) {
    return this.http.post<{ message: string; user: User; verifyLink?: string; otp?: string }>(
      `${this.apiUrl}/register`,
      {
        name: (name || '').trim(),
        email: (email || '').trim().toLowerCase(),
        password: (password || '').trim(),
        role
      }
    );
  }

  verifyOtp(email: string, otp: string) {
    return this.http.post<{ message: string }>(
      `${this.apiUrl}/verify-otp`,
      {
        email: (email || '').trim().toLowerCase(),
        otp: (otp || '').trim(),
      }
    );
  }

  resendOtp(email: string) {
    return this.http.post<{ message: string; verifyLink?: string; otp?: string }>(
      `${this.apiUrl}/resend-otp`,
      {
        email: (email || '').trim().toLowerCase(),
      }
    );
  }

  // 💾 SAVE LOGIN DATA
  saveAuthData(token: string, user: User): void {
    const normalizedUser: User = {
      ...user,
      id: user.id || user._id
    };

    localStorage.setItem(this.TOKEN_KEY, token);
    localStorage.setItem(this.USER_KEY, JSON.stringify(normalizedUser));
    this.authVersion.update((v) => v + 1);
  }

  isTokenExpired(token?: string | null): boolean {
    const raw = token || localStorage.getItem(this.TOKEN_KEY);
    if (!raw || raw === 'null' || raw === 'undefined') return true;

    try {
      const parts = raw.split('.');
      if (parts.length !== 3) return true;

      const payloadJson = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
      const payload = JSON.parse(payloadJson);

      const exp = payload?.exp;
      if (!exp) return false;

      const now = Math.floor(Date.now() / 1000);
      return exp < now;
    } catch {
      return true;
    }
  }

  clearStaleAuth(): void {
    const hadAuth = localStorage.getItem(this.TOKEN_KEY) !== null || localStorage.getItem(this.USER_KEY) !== null;
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.USER_KEY);
    // Deferred: getToken() (which calls this) may run inside a computed/template read.
    if (hadAuth) queueMicrotask(() => this.authVersion.update((v) => v + 1));
  }

  // 🔑 GET TOKEN
  getToken(): string | null {
    const token = localStorage.getItem(this.TOKEN_KEY);
    if (!token || token === 'null' || token === 'undefined' || !token.trim()) {
      return null;
    }

    const clean = token.replace(/^["']|["']$/g, '').trim();
    if (!clean || this.isTokenExpired(clean)) {
      this.clearStaleAuth();
      return null;
    }

    return clean;
  }

  // 👤 GET USER
  getUser(): User | null {
    if (!this.getToken()) {
      return null;
    }
    const user = localStorage.getItem(this.USER_KEY);
    return user ? (JSON.parse(user) as User) : null;
  }

  // ✅ CHECK LOGIN
  isLoggedIn(): boolean {
    return !!this.getToken();
  }

  // =========================
  // 🛡️ ROLE CHECK METHODS
  // =========================

  isUser(): boolean {
    return this.getUser()?.role === 'user';
  }

  isCreator(): boolean {
    return this.getUser()?.role === 'creator';
  }

  isSuperAdmin(): boolean {
    return this.getUser()?.role === 'superadmin';
  }

  // 🚪 LOGOUT
  logout(): void {
    this.clearStaleAuth();
    this.router.navigate(['/login']);
  }
}
