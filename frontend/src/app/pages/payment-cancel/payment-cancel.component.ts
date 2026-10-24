import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../auth/auth.service';
import { ChatService } from '../../components/chat/services/chat.service';

@Component({
  standalone: true,
  imports: [CommonModule],
  selector: 'app-payment-cancel',
  templateUrl: './payment-cancel.component.html',
  styleUrls: ['./payment-cancel.component.css'],
})
export class PaymentCancelComponent implements OnInit, OnDestroy {
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private chat = inject(ChatService);
  private timer: any = null;

  ngOnInit(): void {
    // Release the seats held for this checkout right away instead of waiting for expiry.
    const sessionId = this.route.snapshot.queryParamMap.get('session_id');
    const token = this.auth.getToken();
    if (sessionId && token) {
      this.http
        .post(`${environment.apiUrl}/api/payments/orders/${encodeURIComponent(sessionId)}/cancel`, {}, {
          headers: new HttpHeaders({ Authorization: `Bearer ${token}` }),
        })
        .subscribe({ next: () => this.chat.refreshState(), error: () => this.chat.refreshState() });
    }
    this.timer = setTimeout(() => this.goToEvents(), 3000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  goToEvents() {
    this.router.navigate(['/events']);
  }
}
