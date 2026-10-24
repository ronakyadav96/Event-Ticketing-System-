import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CreatorDashboard } from './creator-dashboard';

describe('CreatorDashboard', () => {
  let component: CreatorDashboard;
  let fixture: ComponentFixture<CreatorDashboard>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CreatorDashboard]
    })
    .compileComponents();

    fixture = TestBed.createComponent(CreatorDashboard);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
