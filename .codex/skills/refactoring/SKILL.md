---
name: refactoring
description: >
  Refactor code for lower coupling, higher cohesion, and better maintainability.
  Use this skill whenever the user asks to refactor, clean up, improve, restructure,
  or "make code better" — even if they don't say "refactoring" explicitly.
  Also trigger when the user asks why code is hard to change, hard to read,
  or has too many dependencies. Apply SOLID, DRY, KISS, YAGNI principles with
  surgical precision — only fix what's broken, never touch unrelated code.
---

# Refactoring Skill

## Goal

Improve code quality on two axes:

- **結合度 (Coupling)** — モジュール間の依存を減らす（疎結合）。1箇所直したとき、無関係な場所がバグらないように。
- **凝集度 (Cohesion)** — モジュール内のコードを1つの目的に集中させる（高凝集）。「便利屋」ではなく「専門店」。

These two are the root cause behind most maintainability problems. The design principles below are concrete techniques to achieve them.

---

## Step 1: Diagnose

Before touching any code, read the target file(s) and identify violations. Score each issue by **impact** (how much it hurts changeability) and **scope** (how many lines/modules are affected). Report the top offenders, not every nit.

### Checklist

**Coupling violations (疎結合 → Low priority = bad)**
- [ ] Direct instantiation of concrete classes inside business logic (`new Foo()` inside unrelated module)
- [ ] Importing implementation details instead of interfaces/abstractions
- [ ] Prop drilling more than 2 levels deep
- [ ] A module knows too much about another module's internals

**Cohesion violations (高凝集 → Low priority = bad)**
- [ ] One class/function doing more than one job (God Object / God Function)
- [ ] File name doesn't match what the file actually does
- [ ] Multiple unrelated exports from the same module
- [ ] State that doesn't belong to the component holding it

**SOLID violations**
- **S** — Single Responsibility: class/function has more than one reason to change
- **O** — Open/Closed: adding a new variant requires modifying existing code (switch/if chain)
- **L** — Liskov Substitution: subtype breaks the contract of its parent
- **I** — Interface Segregation: caller forced to depend on methods it doesn't use
- **D** — Dependency Inversion: high-level module imports low-level concrete class directly

**DRY violations**
- Same logic copy-pasted in 2+ places
- Same business rule encoded in 2+ locations

**KISS violations**
- Abstraction layer exists for only one implementation
- Config/options object with only one ever-set key
- Generic solution to a problem that isn't actually generic

**YAGNI violations**
- Code handles cases that never occur
- Hooks/callbacks/extension points with zero current callers
- "Future-proofing" that adds complexity now

---

## Step 2: Prioritize

Pick the **1–3 highest-impact issues** to fix. Not all 20. State each issue as:

```
Issue: [principle violated] — [one sentence describing the problem]
Impact: [what breaks / what's hard / what duplicates]
Fix: [one sentence describing the change]
Verify: [how to confirm the fix worked]
```

Ask the user to confirm before proceeding if:
- the fix moves code across files
- the fix changes public interfaces
- more than ~30 lines will change

For small, local fixes, proceed directly.

---

## Step 3: Refactor (surgical)

**Rules:**
1. Touch only what the issue requires. Don't clean up adjacent code.
2. Match existing style (naming, formatting) — even if you'd do it differently.
3. Remove imports/variables made unused by YOUR change. Leave pre-existing dead code alone.
4. Preserve behavior. If behavior changes are needed, flag them explicitly.

Apply one fix at a time. After each fix, run the verify step before moving to the next.

---

## Step 4: Verify

After each change, confirm:

1. **Tests pass** — run existing test suite. If no tests exist, write a minimal one that captures the behavior being preserved.
2. **Issue resolved** — the specific violation from Step 2 is gone.
3. **No regressions** — adjacent behavior is intact.

If tests fail, fix the test breakage before declaring done.

---

## Output format

After completing all fixes, summarize:

```
## Refactoring summary

### Fixed
- [Issue 1]: [what changed] — [principle applied]
- [Issue 2]: ...

### Not fixed (out of scope)
- [Issue X]: [why skipped]

### Remaining risk
- [Any leftover smell worth noting]
```

Keep it short. One line per item.

---

## Examples

**Before (DRY violation):**
```ts
// in CartPage.tsx
const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

// in CheckoutPage.tsx
const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
```

**After:**
```ts
// in lib/cart.ts
export const calcTotal = (items: CartItem[]) =>
  items.reduce((sum, item) => sum + item.price * item.quantity, 0);
```

---

**Before (SRP violation):**
```ts
// UserCard does: fetches user data, formats name, renders UI, logs analytics
function UserCard({ userId }) { ... }
```

**After:**
```ts
// Split: useUser() hook fetches, formatUserName() formats, UserCard only renders
```

---

**Before (YAGNI violation):**
```ts
interface Logger {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  trace(msg: string): void;  // never called anywhere
  fatal(msg: string): void;  // never called anywhere
}
```

**After:** Remove unused interface methods. Add them when needed.
