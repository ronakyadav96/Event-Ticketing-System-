import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';

export const adminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const user = auth.getUser();

  // ✅ Only Superadmin allowed
  if (user?.role === 'superadmin') {
    return true;
  }

  return router.parseUrl('/events');
};
