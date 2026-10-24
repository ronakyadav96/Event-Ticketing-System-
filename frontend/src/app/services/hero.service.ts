import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { environment } from '../../environments/environment';

export type HeroImageDto = {
  _id: string;
  url: string; // relative: /uploads/hero/...
  createdAt?: string;
};

@Injectable({ providedIn: 'root' })
export class HeroService {
  private API = `${environment.apiUrl}/api/hero-images`;
  private ADMIN_API = `${environment.apiUrl}/api/admin/hero-images`;

  constructor(private http: HttpClient) {}

  private authHeaders() {
    const token = localStorage.getItem('token');
    return {
      headers: new HttpHeaders({
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      }),
    };
  }

  getPublicHeroImages(): Observable<HeroImageDto[]> {
    return this.http.get<any>(this.API).pipe(
      map((res) => {
        const list = res?.images;
        return Array.isArray(list) ? (list as HeroImageDto[]) : [];
      })
    );
  }

  getAdminHeroImages(): Observable<HeroImageDto[]> {
    return this.http.get<any>(this.ADMIN_API, this.authHeaders()).pipe(
      map((res) => {
        const list = res?.images;
        return Array.isArray(list) ? (list as HeroImageDto[]) : [];
      })
    );
  }

  uploadHeroImage(file: File): Observable<HeroImageDto> {
    const fd = new FormData();
    fd.append('image', file);
    return this.http.post<any>(this.ADMIN_API, fd, this.authHeaders()).pipe(
      map((res) => res?.image as HeroImageDto)
    );
  }

  deleteHeroImage(id: string): Observable<any> {
    return this.http.delete(`${this.ADMIN_API}/${id}`, this.authHeaders());
  }
}

