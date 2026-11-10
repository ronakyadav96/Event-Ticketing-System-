import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

import { environment } from '../../environments/environment';
import { AuthService } from '../auth/auth.service';

const BACKEND_API = `${environment.apiUrl}/api/`;

/**
 * When the backend rejects our token (expired, revoked, account deleted), sign out and
 * send the user to login instead of leaving every page failing silently.
 * Auth endpoints are skipped: a 401 there just means wrong credentials.
 */
export const authExpiredInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  return next(req).pipe(
    catchError((err: unknown) => {
      const isBackend = req.url.startsWith(BACKEND_API) && !req.url.startsWith(`${BACKEND_API}auth/`);
      const sentToken = req.headers.has('Authorization');
      if (err instanceof HttpErrorResponse && err.status === 401 && isBackend && sentToken) {
        auth.clearStaleAuth();
        if (!router.url.startsWith('/login')) {
          router.navigate(['/login'], { queryParams: { returnUrl: router.url } });
        }
      }
      return throwError(() => err);
    })
  );
};
