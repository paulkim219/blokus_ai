"""Regression checks for the replay's discovery and held-out scoring contrasts."""
import unittest

from v6_replay_followup import ARMS, pairs


class DiscoveryContrasts(unittest.TestCase):
    def test_same_selector_can_benefit_from_different_nomination(self):
        # Generic and oracle agree on every ranking. Only oracle can nominate 30.
        row = {"base": [10], "pool": [10, 20, 30],
               "nominees": {a: 30 if a == "oracle" else 20 for a in ARMS},
               "planning": {a: [[0, 1, 2], [0, 1, 2]] for a in ARMS},
               "evaluation": [5, 3, 9]}
        for budget in (0, 1):
            results = pairs(row, budget)
            self.assertEqual(results["exact_information_base"], (False, 0))
            self.assertEqual(results["exact_information_pool"], (False, 0))
            self.assertEqual(results["exact_information_own"], (True, 6))
            self.assertEqual(results["oracle_own_vs_generic_nomination"], (True, 6))
            # Planning still chooses 20 over 10 despite its worse independent score.
            self.assertEqual(results["generic_nomination_vs_base"], (True, -2))

    def test_unavailable_decision_stays_in_denominator(self):
        row = {"base": [], "pool": [], "nominees": dict.fromkeys(ARMS),
               "planning": {a: [[], []] for a in ARMS}, "evaluation": []}
        self.assertTrue(all(pair == (False, 0) for pair in pairs(row, 0).values()))


if __name__ == "__main__":
    unittest.main()
