import { createTestCache } from "./index";
import type { Clock } from "@safecache/core";

const arbitraryClock: Clock = { now: () => 0 };
// EXPECT a compile error here: clock must be FakeClock | undefined
createTestCache({ clock: arbitraryClock });
