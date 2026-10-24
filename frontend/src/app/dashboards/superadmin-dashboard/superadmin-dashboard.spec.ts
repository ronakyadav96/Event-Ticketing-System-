import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SuperadminDashboardComponent } from './superadmin-dashboard.component';

describe('SuperadminDashboard', () => {
  let component: SuperadminDashboardComponent;
  let fixture: ComponentFixture<SuperadminDashboardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SuperadminDashboardComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(SuperadminDashboardComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
