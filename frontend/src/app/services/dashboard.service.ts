import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class DashboardService {

  private API = `${environment.apiUrl}/api/dashboard`;
  private ADMIN_API = `${environment.apiUrl}/api/admin`;
  private EVENTS_API = `${environment.apiUrl}/api/events`;

  constructor(private http: HttpClient) {}

  // 🔐 Common Auth Header
  private getAuthHeaders() {
    const token = localStorage.getItem('token');

    return {
      headers: new HttpHeaders({
        Authorization: token ? `Bearer ${token}` : ''
      })
    };
  }

  // 👑 Superadmin Dashboard
  getSuperadminDashboard() {
    return this.http.get(
      `${this.API}/superadmin`,
      this.getAuthHeaders()
    );
  }

  // 👑 Superadmin: Users
  getAllUsers(params?: { page?: number; limit?: number; role?: string }) {
    let httpParams = new HttpParams();
    if (params?.page) httpParams = httpParams.set('page', String(params.page));
    if (params?.limit) httpParams = httpParams.set('limit', String(params.limit));
    if (params?.role) httpParams = httpParams.set('role', params.role);

    return this.http.get(
      `${this.ADMIN_API}/users`,
      { ...this.getAuthHeaders(), params: httpParams }
    );
  }

  updateUser(id: string, payload: { name?: string; role?: string }) {
    return this.http.put(
      `${this.ADMIN_API}/users/${id}`,
      payload,
      this.getAuthHeaders()
    );
  }

  deleteUser(id: string) {
    return this.http.delete(
      `${this.ADMIN_API}/users/${id}`,
      this.getAuthHeaders()
    );
  }

  // 👑 Superadmin: Events
  getAllEvents(params?: { page?: number; limit?: number }) {
    let httpParams = new HttpParams();
    if (params?.page) httpParams = httpParams.set('page', String(params.page));
    if (params?.limit) httpParams = httpParams.set('limit', String(params.limit));

    return this.http.get(
      `${this.EVENTS_API}`,
      { ...this.getAuthHeaders(), params: httpParams }
    );
  }

  deleteEvent(id: string) {
    return this.http.delete(
      `${this.EVENTS_API}/${id}`,
      this.getAuthHeaders()
    );
  }

  // 👤 Creator Dashboard
  getCreatorDashboard() {
    return this.http.get(
      `${this.API}/creator`,
      this.getAuthHeaders()
    );
  }
} 

