// src/app/app.routes.ts

import { Routes } from '@angular/router';

import { LoginComponent } from './auth/login/login.component';
import { RegisterComponent } from './auth/register/register.component';

import { HomeComponent } from './pages/home/home.component';
import { ExploreComponent } from './pages/explore/explore.component';
import { EventDetailsComponent } from './pages/event-details/event-details.component';
import { CreateEventComponent } from './pages/create-event/create-event.component';
import { BookingConfirmationComponent } from './pages/booking-confirmation/booking-confirmation.component';
import { BookingHistoryComponent } from './pages/booking-history/booking-history.component';
import { PromotionsComponent } from './pages/promotions/promotions.component';
import { MovieRecommendationsComponent } from './pages/movie-recommendations/movie-recommendations.component';
import { MovieDetailsComponent } from './pages/movie-details/movie-details.component';

import { PaymentSuccessComponent } from './pages/payment-success/payment-success.component';
import { PaymentCancelComponent } from './pages/payment-cancel/payment-cancel.component';

import { BookingPageComponent } from './pages/booking-page/booking-page.component';

import { authGuard, guestGuard } from './auth/auth-guard';

export const routes: Routes = [

  // ---------- AUTH ----------
  { path: '', redirectTo: 'events', pathMatch: 'full' },
  { path: 'login', component: LoginComponent, canActivate: [guestGuard] },
  { path: 'register', component: RegisterComponent, canActivate: [guestGuard] },

  // ---------- USER ----------
  { path: 'events', component: HomeComponent },
  { path: 'explore', component: ExploreComponent },
  { path: 'book/:eventId', component: BookingPageComponent, canActivate: [authGuard] },
  { path: 'movies', component: MovieRecommendationsComponent },
  { path: 'movies/search', component: MovieRecommendationsComponent },
  { path: 'movies/:movieId', component: MovieDetailsComponent },
  // Anyone can browse details; booking (/book/:eventId) requires sign-in.
  { path: 'events/:id', component: EventDetailsComponent },
  { path: 'history', component: BookingHistoryComponent, canActivate: [authGuard] },
  { path: 'gifts', component: PromotionsComponent, canActivate: [authGuard], data: { kind: 'gift' } },
  { path: 'coupons', component: PromotionsComponent, canActivate: [authGuard], data: { kind: 'coupon' } },

  { path: 'payment-success', component: PaymentSuccessComponent, canActivate: [authGuard] },
  { path: 'payment-cancel', component: PaymentCancelComponent, canActivate: [authGuard] },

  { path: 'booking/:ticketId', component: BookingConfirmationComponent, canActivate: [authGuard] },

  // ---------- CREATOR + SUPERADMIN ----------

  {
  path: 'creator-dashboard',
  loadComponent: () =>
    import('./dashboards/creator-dashboard/creator-dashboard.component')
      .then(m => m.CreatorDashboardComponent),
  canActivate: [authGuard],
  data: { role: 'creator' }
},

{
  path: 'superadmin-dashboard',
  loadComponent: () =>
    import('./dashboards/superadmin-dashboard/superadmin-dashboard.component')
      .then(m => m.SuperadminDashboardComponent),
  canActivate: [authGuard],
  data: { role: 'superadmin' }
},


  {
    path: 'create-event',
    component: CreateEventComponent,
    canActivate: [authGuard],
    data: { role: 'creator' }
  },
  

  // ---------- FALLBACK ----------
  { path: '**', redirectTo: 'events' }

];
