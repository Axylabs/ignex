/** @fileoverview Functional use-case composition and type-inference contracts. */

import { defineUseCase, type UseCase } from "@ignex/core";
import { describe, expect, expectTypeOf, it, vi } from "vitest";

interface Account {
  readonly id: string;
  readonly balance: number;
}

interface AccountRepository {
  find(id: string): Promise<Account>;
  save(account: Account): Promise<void>;
}

interface WithdrawInput {
  readonly accountId: string;
  readonly amount: number;
}

const withdraw = (account: Account, amount: number): Account => {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > account.balance) {
    throw new RangeError("Invalid withdrawal");
  }
  return { ...account, balance: account.balance - amount };
};

const withdrawFactory = defineUseCase(
  async ({ accounts }: { readonly accounts: AccountRepository }, input: WithdrawInput) => {
    const account = await accounts.find(input.accountId);
    const updated = withdraw(account, input.amount);
    await accounts.save(updated);
    return updated;
  },
);

describe("defineUseCase", () => {
  it("binds shared ports separately from invocation input", async () => {
    const accounts: AccountRepository = {
      find: vi.fn(async (id: string) => ({ id, balance: 100 })),
      save: vi.fn(async () => {}),
    };
    const execute = withdrawFactory({ accounts });

    await expect(execute({ accountId: "a", amount: 25 })).resolves.toEqual({
      id: "a",
      balance: 75,
    });
    expect(accounts.find).toHaveBeenCalledExactlyOnceWith("a");
    expect(accounts.save).toHaveBeenCalledExactlyOnceWith({ id: "a", balance: 75 });
  });

  it("does not share invocation values between bound instances", async () => {
    const first = defineUseCase((prefix: string, value: number) => `${prefix}:${value}`)("first");
    const second = defineUseCase((prefix: string, value: number) => `${prefix}:${value}`)("second");

    expect(first(1)).toBe("first:1");
    expect(second(2)).toBe("second:2");
    expect(first(3)).toBe("first:3");
  });

  it("preserves synchronous and asynchronous input/output types", () => {
    const synchronous = defineUseCase((_dependencies: object, value: number) => value * 2)({});
    const asynchronous = defineUseCase(async (_dependencies: object, value: string) => value)({});

    expectTypeOf(synchronous).toEqualTypeOf<UseCase<number, number>>();
    expectTypeOf(asynchronous).toEqualTypeOf<UseCase<string, string>>();
    expectTypeOf(synchronous(2)).toEqualTypeOf<number | Promise<number>>();
  });
});
