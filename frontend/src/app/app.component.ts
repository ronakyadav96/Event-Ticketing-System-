import { Component, inject, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  Router,
  RouterOutlet,
  RouterLink,
  RouterLinkActive,
  NavigationEnd
} from '@angular/router';
import { filter, Subject, takeUntil } from 'rxjs';
import { AuthService } from './auth/auth.service';
import { FooterComponent } from './shared/footer/footer.component';
import { CitySelectorComponent } from './shared/city-selector/city-selector.component';
import { ChatWidgetComponent } from './components/chat/chat-widget.component';
import { SearchBoxComponent } from './shared/search-box/search-box.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    FooterComponent,
    CitySelectorComponent,
    ChatWidgetComponent,
    SearchBoxComponent,
  ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent implements OnDestroy {

  private router = inject(Router);
  private authService = inject(AuthService);

  private destroy$ = new Subject<void>();

  isLoginPage = false;
  isRegisterPage = false;
  isDrawerOpen = false;
  /** Which second-tier nav link is highlighted: 'movies', 'events' or an explore category. */
  activeNav = '';

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntil(this.destroy$)
      )
      .subscribe((event: NavigationEnd) => {
        const url = event.urlAfterRedirects;
        const urlTree = this.router.parseUrl(url);

        this.isLoginPage = url.includes('/login');
        this.isRegisterPage = url.includes('/register');
        const first = urlTree.root.children['primary']?.segments?.[0]?.path || '';
        const category = String(urlTree.queryParams?.['category'] || '');
        this.activeNav =
          first === 'movies' ? 'movies'
          : first === 'explore' ? (category && !category.includes(',') ? category : 'events')
          : '';
        this.isDrawerOpen = false;
      });

  }

  // =====================
  // ROLE HELPERS
  // =====================

  get currentUser() {
    return this.authService.getUser();
  }

  get userDisplayName(): string {
    const user = this.currentUser;
    if (user?.name) return user.name;
    if (user?.email) return user.email.split('@')[0];
    return 'User';
  }

  get userInitial(): string {
    const name = this.userDisplayName;
    return name ? name.charAt(0).toUpperCase() : 'U';
  }

  get isLoggedIn(): boolean {
    return this.authService.isLoggedIn();
  }

  get isUser(): boolean {
    return this.currentUser?.role === 'user';
  }

  get isCreator(): boolean {
    return this.currentUser?.role === 'creator';
  }

  get isSuperAdmin(): boolean {
    return this.currentUser?.role === 'superadmin';
  }

  // Superadmin should also see creator features
  get canManageEvents(): boolean {
    return this.isCreator || this.isSuperAdmin;
  }

  // =====================
  // LOGOUT
  // =====================

  logout(): void {
    try {
      this.authService.logout();
    } catch (err) {
      console.error('Logout error:', err);
    } finally {
      this.isDrawerOpen = false;
      this.router.navigate(['/events']);
    }
  }

  toggleDrawer(): void {
    this.isDrawerOpen = !this.isDrawerOpen;
  }

  closeDrawer(): void {
    this.isDrawerOpen = false;
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
