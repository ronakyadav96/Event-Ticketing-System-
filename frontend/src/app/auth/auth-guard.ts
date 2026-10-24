import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree, ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';

function isTokenExpired(token: string): boolean {
  try {
    const payloadPart = token.split('.')[1];
    if (!payloadPart) return true;

    const payloadJson = atob(payloadPart.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(payloadJson);

    const exp = payload?.exp;
    if (!exp) return false;

    const now = Math.floor(Date.now() / 1000);
    return exp < now;
  } catch {
    return true;
  }
}

function getUserRole(): string | null {
  try {
    const user = localStorage.getItem('user');
    if (!user) return null;
    return JSON.parse(user)?.role || null;
  } catch {
    return null;
  }
}

export const authGuard: CanActivateFn = (
  route: ActivatedRouteSnapshot,
  state: RouterStateSnapshot
): boolean | UrlTree => {

  const router = inject(Router);
  const token = localStorage.getItem('token');
  // After signing in, the login page sends the user back here.
  const toLogin = () => router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });

  // 🔒 1️⃣ Must have token
  if (!token) {
    return toLogin();
  }

  // 🔒 2️⃣ Token should not be expired
  if (isTokenExpired(token)) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    return toLogin();
  }

  // 🔒 3️⃣ Role-based check (if required)
  const requiredRole = route.data?.['role'];

  if (requiredRole) {
    const userRole = getUserRole();

    // Allow superadmin everywhere
    if (userRole === 'superadmin') {
      return true;
    }

    if (userRole !== requiredRole) {
      return router.parseUrl('/events');
    }
  }

  return true;
};

export const guestGuard: CanActivateFn = (): boolean | UrlTree => {
  const router = inject(Router);
  const token = localStorage.getItem('token');

  if (!token) {
    return true;
  }

  if (isTokenExpired(token)) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    return true;
  }

  const role = getUserRole();
  if (role === 'creator') {
    return router.parseUrl('/creator-dashboard');
  }
  if (role === 'superadmin') {
    return router.parseUrl('/superadmin-dashboard');
  }
  return router.parseUrl('/events');
};
