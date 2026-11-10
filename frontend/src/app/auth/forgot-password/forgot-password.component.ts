import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-forgot-password',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './forgot-password.component.html',
  styleUrls: ['../login/login.component.css'],
})
export class ForgotPasswordComponent {
  step: 'email' | 'reset' = 'email';
  email = '';
  otp = '';
  password = '';
  confirmPassword = '';
  error = '';
  info = '';
  loading = false;

  constructor(private auth: AuthService, private router: Router) {}

  requestOtp() {
    this.error = '';
    this.info = '';
    if (!this.email.trim()) {
      this.error = 'Please enter your email';
      return;
    }
    this.loading = true;
    this.auth.forgotPassword(this.email).subscribe({
      next: (res) => {
        this.loading = false;
        this.step = 'reset';
        // The OTP is only returned when the backend runs with MAIL_DISABLED=true (development).
        this.info = res.otp ? `${res.message} (dev OTP: ${res.otp})` : res.message;
      },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.message || 'Could not send the reset OTP';
      },
    });
  }

  resetPassword() {
    this.error = '';
    if (!this.otp.trim() || !this.password) {
      this.error = 'Please enter the OTP and a new password';
      return;
    }
    if (this.password.length < 6) {
      this.error = 'Password must be at least 6 characters';
      return;
    }
    if (this.password !== this.confirmPassword) {
      this.error = 'Passwords do not match';
      return;
    }
    this.loading = true;
    this.auth.resetPassword(this.email, this.otp, this.password).subscribe({
      next: () => {
        this.loading = false;
        this.router.navigate(['/login'], { queryParams: { reset: '1' } });
      },
      error: (err) => {
        this.loading = false;
        this.error = err?.error?.message || 'Password reset failed';
      },
    });
  }
}
