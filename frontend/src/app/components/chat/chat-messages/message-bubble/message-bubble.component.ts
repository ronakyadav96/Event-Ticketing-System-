import { Component, Input, SecurityContext, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { ChatMessage } from '../../models/chat.models';

@Component({
  selector: 'app-message-bubble',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './message-bubble.component.html',
  styleUrls: ['./message-bubble.component.scss'],
})
export class MessageBubbleComponent {
  @Input({ required: true }) message!: ChatMessage;

  private sanitizer = inject(DomSanitizer);

  formatTimestamp(date: Date | string | undefined): string {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  get formattedContent(): SafeHtml {
    if (!this.message || !this.message.text) return '';
    const text = this.message.text;

    // Simple, resilient Markdown parser
    let html = text
      // Escape raw HTML entities
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      // Headers
      .replace(/^### (.*$)/gim, '<h4 class="md-h4">$1</h4>')
      .replace(/^## (.*$)/gim, '<h3 class="md-h3">$1</h3>')
      .replace(/^# (.*$)/gim, '<h2 class="md-h2">$1</h2>')
      // Bold
      .replace(/\*\*(.*?)\*\*/gim, '<strong class="md-bold">$1</strong>')
      // Italic
      .replace(/\*(.*?)\*/gim, '<em class="md-italic">$1</em>')
      // Inline code / tags
      .replace(/`([^`]+)`/gim, '<code class="md-code">$1</code>')
      // Bullet lists
      .replace(/^\s*[-•]\s+(.*$)/gim, '<li class="md-list-item">$1</li>')
      // Numbered lists
      .replace(/^\s*(\d+)\.\s+(.*$)/gim, '<li class="md-ordered-item"><span class="md-num">$1.</span> $2</li>')
      // Line breaks
      .replace(/\n\n/g, '<div class="md-p-gap"></div>')
      .replace(/\n/g, '<br/>');

    // List items are block elements: drop the line breaks between them.
    html = html.replace(/<\/li>(?:<br\/>|<div class="md-p-gap"><\/div>)(?=<li)/g, '</li>');

    // Wrap list items
    html = html.replace(/(<li class="md-list-item">.*<\/li>)/gms, '<ul class="md-ul">$1</ul>');
    html = html.replace(/(<li class="md-ordered-item">.*<\/li>)/gms, '<ol class="md-ol">$1</ol>');

    const sanitized = this.sanitizer.sanitize(SecurityContext.HTML, html) || '';
    return this.sanitizer.bypassSecurityTrustHtml(sanitized);
  }
}

