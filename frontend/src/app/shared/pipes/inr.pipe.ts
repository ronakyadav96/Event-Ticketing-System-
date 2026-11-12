import { Pipe, PipeTransform } from '@angular/core';

/** Formats rupees with Indian digit grouping: 114198 -> "₹1,14,198". */
@Pipe({ name: 'inr', standalone: true })
export class InrPipe implements PipeTransform {
  transform(value: number | string | null | undefined): string {
    const n = Math.round(Number(value) || 0);
    return `₹${n.toLocaleString('en-IN')}`;
  }
}
