import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';

import { authGuard, guestGuard } from './auth-guard';

function fakeToken(expSecondsFromNow: number): string {
  const payload = btoa(JSON.stringify({ id: "u1", exp: Math.floor(Date.now() / 1000) + expSecondsFromNow }));
  return `header.${payload}.signature`;
}

function runAuthGuard(data: Record<string, unknown> = {}, url = '/history') {
  const route = { data } as unknown as ActivatedRouteSnapshot;
  const state = { url } as RouterStateSnapshot;
  return TestBed.runInInjectionContext(() => authGuard(route, state));
}

describe('authGuard', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  it('sends signed-out users to login with a returnUrl', () => {
    const result = runAuthGuard() as UrlTree;
    expect(TestBed.inject(Router).serializeUrl(result)).toBe('/login?returnUrl=%2Fhistory');
  });

  it('clears an expired token and redirects to login', () => {
    localStorage.setItem('token', fakeToken(-60));
    localStorage.setItem('user', JSON.stringify({ role: 'user' }));
    expect(runAuthGuard()).toBeInstanceOf(UrlTree);
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('lets a signed-in user through', () => {
    localStorage.setItem('token', fakeToken(3600));
    localStorage.setItem('user', JSON.stringify({ role: 'user' }));
    expect(runAuthGuard()).toBe(true);
  });

  it('blocks a user from a creator-only page', () => {
    localStorage.setItem('token', fakeToken(3600));
    localStorage.setItem('user', JSON.stringify({ role: 'user' }));
    const result = runAuthGuard({ role: 'creator' }) as UrlTree;
    expect(TestBed.inject(Router).serializeUrl(result)).toBe('/events');
  });

  it('lets a superadmin into role-restricted pages', () => {
    localStorage.setItem('token', fakeToken(3600));
    localStorage.setItem('user', JSON.stringify({ role: 'superadmin' }));
    expect(runAuthGuard({ role: 'creator' })).toBe(true);
  });
});

describe('guestGuard', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  it('allows guests', () => {
    const result = TestBed.runInInjectionContext(() =>
      guestGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot)
    );
    expect(result).toBe(true);
  });

  it('sends a signed-in creator to their dashboard', () => {
    localStorage.setItem('token', fakeToken(3600));
    localStorage.setItem('user', JSON.stringify({ role: 'creator' }));
    const result = TestBed.runInInjectionContext(() =>
      guestGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot)
    ) as UrlTree;
    expect(TestBed.inject(Router).serializeUrl(result)).toBe('/creator-dashboard');
  });
});
