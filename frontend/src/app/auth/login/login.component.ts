import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.css']
})
export class LoginComponent {
  email = '';
  password = '';
  error = '';
  loading = false;

  constructor(
    private auth: AuthService,
    private router: Router,
    private route: ActivatedRoute
  ) {}

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

        const role = res?.user?.role;
        if (role === 'superadmin') {
          this.router.navigate(['/superadmin-dashboard']);
        } else if (role === 'creator') {
          this.router.navigate(['/creator-dashboard']);
        } else {
          this.router.navigate(['/events']);
        }
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
