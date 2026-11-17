// src/app/app.routes.ts

import { Routes } from '@angular/router';

import { authGuard, guestGuard } from './auth/auth-guard';

// Every page is its own lazily loaded chunk, so the first visit only downloads the page it
// opens; the rest are preloaded in the background once the app is idle (see app.config.ts).
export const routes: Routes = [

  // ---------- AUTH ----------
  { path: '', redirectTo: 'events', pathMatch: 'full' },
  {
    path: 'login',
    loadComponent: () => import('./auth/login/login.component').then((m) => m.LoginComponent),
    canActivate: [guestGuard],
  },
  {
    path: 'register',
    loadComponent: () => import('./auth/register/register.component').then((m) => m.RegisterComponent),
    canActivate: [guestGuard],
  },
  {
    path: 'forgot-password',
    loadComponent: () => import('./auth/forgot-password/forgot-password.component').then((m) => m.ForgotPasswordComponent),
    canActivate: [guestGuard],
  },

  // ---------- USER ----------
  // Everything past login requires an account: visitors are sent to /login first.
  {
    path: 'events',
    loadComponent: () => import('./pages/events/events.component').then((m) => m.EventsComponent),
    canActivate: [authGuard],
  },
  {
    path: 'book/:eventId',
    loadComponent: () => import('./pages/booking-page/booking-page.component').then((m) => m.BookingPageComponent),
    canActivate: [authGuard],
  },
  {
    path: 'movies',
    loadComponent: () =>
      import('./pages/movie-recommendations/movie-recommendations.component').then((m) => m.MovieRecommendationsComponent),
    canActivate: [authGuard],
  },
  {
    path: 'movies/search',
    loadComponent: () =>
      import('./pages/movie-recommendations/movie-recommendations.component').then((m) => m.MovieRecommendationsComponent),
    canActivate: [authGuard],
  },
  {
    path: 'movies/:movieId',
    loadComponent: () => import('./pages/movie-details/movie-details.component').then((m) => m.MovieDetailsComponent),
    canActivate: [authGuard],
  },
  {
    path: 'events/:id',
    loadComponent: () => import('./pages/event-details/event-details.component').then((m) => m.EventDetailsComponent),
    canActivate: [authGuard],
  },
  {
    path: 'history',
    loadComponent: () => import('./pages/booking-history/booking-history.component').then((m) => m.BookingHistoryComponent),
    canActivate: [authGuard],
  },
  {
    path: 'gifts',
    loadComponent: () => import('./pages/promotions/promotions.component').then((m) => m.PromotionsComponent),
    canActivate: [authGuard],
    data: { kind: 'gift' },
  },
  {
    path: 'coupons',
    loadComponent: () => import('./pages/promotions/promotions.component').then((m) => m.PromotionsComponent),
    canActivate: [authGuard],
    data: { kind: 'coupon' },
  },

  {
    path: 'payment-success',
    loadComponent: () => import('./pages/payment-success/payment-success.component').then((m) => m.PaymentSuccessComponent),
    canActivate: [authGuard],
  },
  {
    path: 'payment-cancel',
    loadComponent: () => import('./pages/payment-cancel/payment-cancel.component').then((m) => m.PaymentCancelComponent),
    canActivate: [authGuard],
  },

  {
    path: 'booking/:ticketId',
    loadComponent: () =>
      import('./pages/booking-confirmation/booking-confirmation.component').then((m) => m.BookingConfirmationComponent),
    canActivate: [authGuard],
  },

  // ---------- CREATOR + SUPERADMIN ----------
  {
    path: 'creator-dashboard',
    loadComponent: () =>
      import('./dashboards/creator-dashboard/creator-dashboard.component').then((m) => m.CreatorDashboardComponent),
    canActivate: [authGuard],
    data: { role: 'creator' },
  },
  {
    path: 'superadmin-dashboard',
    loadComponent: () =>
      import('./dashboards/superadmin-dashboard/superadmin-dashboard.component').then((m) => m.SuperadminDashboardComponent),
    canActivate: [authGuard],
    data: { role: 'superadmin' },
  },
  {
    path: 'create-event',
    loadComponent: () => import('./pages/create-event/create-event.component').then((m) => m.CreateEventComponent),
    canActivate: [authGuard],
    data: { role: 'creator' },
  },

  // ---------- FALLBACK ----------
  { path: '**', redirectTo: 'events' },
];
