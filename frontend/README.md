# EventTicketingApp

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.1.0.

## Development server

To start the local frontend and backend together, run:

```bash
npm start
```

This starts Angular on `http://localhost:4200/` and reuses or starts the backend on port `5001`. The backend keeps retrying MongoDB if the database is temporarily unavailable, so a transient database/DNS failure does not stop the development server. Make sure `event-ticketing-backend/.env` contains valid `MONGO_URI` and `JWT_SECRET` values.

To run only the Angular frontend, use `npm run start:frontend`.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
