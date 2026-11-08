/**
 * @fileoverview Functional use-case definitions with explicit dependency and
 * request boundaries. The factory performs no I/O and stores no request data.
 */

/** An executable use case. Input and output may be synchronous or asynchronous. */
export type UseCase<TInput, TOutput> = (input: TInput) => TOutput | Promise<TOutput>;

/**
 * A use-case implementation receiving application dependencies and one input.
 * Dependencies are supplied separately so request values are never captured by
 * an application-scoped instance.
 */
export type UseCaseImplementation<TDependencies, TInput, TOutput> = (
  dependencies: TDependencies,
  input: TInput,
) => TOutput | Promise<TOutput>;

/** A factory binding application dependencies to a reusable {@link UseCase}. */
export type UseCaseFactory<TDependencies, TInput, TOutput> = (
  dependencies: TDependencies,
) => UseCase<TInput, TOutput>;

/**
 * Define a use case as a higher-order function.
 *
 * The returned factory binds application-scoped ports once; the resulting
 * function receives only invocation input. This makes shared instances an
 * explicit choice while preventing one request's values from becoming closure
 * state. Domain decisions should remain pure, with I/O behind the injected
 * ports. Create request-scoped dependencies in the route and pass them as part
 * of the input instead of storing them in a module-level variable.
 *
 * @param implementation - Pure orchestration or I/O using explicit ports.
 * @returns A factory that binds dependencies and returns an executable use case.
 * @example
 * ```ts
 * interface Clock { now(): number }
 * interface GreetingInput { readonly name: string }
 *
 * const greeting = defineUseCase(
 *   ({ clock }: { readonly clock: Clock }, input: GreetingInput) =>
 *     `${input.name}:${clock.now()}`,
 * );
 * const executeGreeting = greeting({ clock: { now: () => 123 } });
 * const result = executeGreeting({ name: "Ada" });
 * ```
 */
export const defineUseCase =
  <TDependencies, TInput, TOutput>(
    implementation: UseCaseImplementation<TDependencies, TInput, TOutput>,
  ): UseCaseFactory<TDependencies, TInput, TOutput> =>
  (dependencies) =>
  (input) =>
    implementation(dependencies, input);
