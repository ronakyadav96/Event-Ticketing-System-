import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BrandLogoComponent } from '../../theme/brand-logo.component';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule, BrandLogoComponent, RouterLink],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.css']
})
export class LoginComponent {
  email = '';
  password = '';
  error = '';
  loading = false;
  resetDone = false;

  constructor(
    private auth: AuthService,
    private router: Router,
    private route: ActivatedRoute
  ) {
    this.resetDone = this.route.snapshot.queryParamMap.get('reset') === '1';
  }

  goToRegister() {
    this.router.navigate(['/register']);
  }

  login() {
    this.error = '';
    this.loading = true;

    this.auth.login(this.email, this.password).subscribe({
      next: (res: any) => {
        this.auth.saveAuthData(res.token, res.user);

        // Send the user back to the page that asked them to sign in (e.g. a booking page).
        const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl') || '';
        if (returnUrl.startsWith('/') && !returnUrl.startsWith('//')) {
          this.router.navigateByUrl(returnUrl);
          return;
        }

        // Users and creators land on the home page (creators reach their tools from the header);
        // the superadmin starts in the admin portal.
        const role = res?.user?.role;
        this.router.navigate([role === 'superadmin' ? '/superadmin-dashboard' : '/events']);
      },
      error: (err) => {
        this.error = err?.error?.message || 'Invalid email or password';
        this.loading = false;
      },
      complete: () => {
        this.loading = false;
      },
    });
  }
}
