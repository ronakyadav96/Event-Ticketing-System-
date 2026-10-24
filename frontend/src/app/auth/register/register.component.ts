import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './register.component.html',
  styleUrls: ['./register.component.css']
})
export class RegisterComponent {
  name = '';
  email = '';
  password = '';
  role = '';
  error = '';
  success = '';
  otp = '';
  otpError = '';
  otpStep = false;
  submitted = false;
  loading = false;

  constructor(
    private auth: AuthService,
    private router: Router
  ) {}

  validEmail(): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email);
  }

  hasUpper(): boolean {
    return /[A-Z]/.test(this.password);
  }

  hasSymbol(): boolean {
    return /[^A-Za-z0-9]/.test(this.password);
  }

  hasTwoNumbers(): boolean {
    const matches = this.password.match(/[0-9]/g) || [];
    return matches.length >= 2;
  }

  validPassword(): boolean {
    return this.password.length >= 6 && this.hasUpper() && this.hasSymbol() && this.hasTwoNumbers();
  }

  register() {
    this.submitted = true;
    this.error = '';
    this.success = '';
    this.otp = '';
    this.otpError = '';
    this.otpStep = false;
    this.loading = true;

    if (!this.name || !this.validEmail() || !this.validPassword() || !this.role) {
      this.loading = false;
      return;
    }

    this.auth.register(this.name, this.email, this.password, this.role).subscribe({
      next: (res: any) => {
        this.success = res?.message || 'Registration successful. Please verify your email.';
        this.otpStep = true;
      },
      error: (err) => {
        this.error = err?.error?.message || 'Registration failed';
        this.loading = false;
      },
      complete: () => {
        this.loading = false;
      },
    });
  }

  verifyOtp() {
    this.otpError = '';

    if (!this.email || !this.otp) {
      this.otpError = 'Email and OTP are required';
      return;
    }

    this.auth.verifyOtp(this.email, this.otp).subscribe({
      next: (res: any) => {
        this.success = res?.message || 'Email verified successfully. You can login now.';
        this.router.navigate(['/login']);
      },
      error: (err) => {
        this.otpError = err?.error?.message || 'OTP verification failed';
      }
    });
  }

  resendOtp() {
    this.otpError = '';

    if (!this.email) {
      this.otpError = 'Email is required';
      return;
    }

    this.auth.resendOtp(this.email).subscribe({
      next: (res: any) => {
        this.success = res?.message || 'OTP resent. Check your email.';
        if (res?.otp) {
          this.otp = res.otp;
        }
      },
      error: (err) => {
        this.otpError = err?.error?.message || 'Resend OTP failed';
      }
    });
  }

  goToLogin() {
    this.router.navigate(['/login']);
  }
}
