//! v5.0 port P7 (`native.lastGoodReply`): a last-good-reply table for rollouts.
//!
//! Per seat, the reply that seat played to a given previous placement in the last simulation it won
//! (score equal to the highest; ties count as won). With forgetting, a reply played in a simulation the
//! seat did not win is removed if it is the stored one. Written from the idea in the literature
//! (Drake's last-good-reply; Baier & Drake's forgetting variant), keyed on the immediately preceding
//! placement only.

use crate::placements::placements;
use crate::position::SEAT_COUNT;

pub struct ReplyTable {
    /// `reply[prev * SEAT_COUNT + seat]`, -1 for none.
    reply: Vec<i32>,
    forget: bool,
    /// Rollout moves asked of the table, and how many it supplied (diagnostics only).
    pub asked: u64,
    pub supplied: u64,
}

impl ReplyTable {
    pub fn new(forget: bool) -> ReplyTable {
        ReplyTable { reply: vec![-1; placements().count * SEAT_COUNT], forget, asked: 0, supplied: 0 }
    }

    pub fn clear(&mut self) {
        self.reply.fill(-1);
    }

    /// The stored reply of `seat` to `prev`, or -1.
    #[inline(always)]
    pub fn get(&self, seat: usize, prev: i32) -> i32 {
        if prev < 0 { -1 } else { self.reply[prev as usize * SEAT_COUNT + seat] }
    }

    /// Learns from one simulation: `moves` are its placements in order as (seat, placement), `prev`
    /// the placement just before the first of them (-1 if none), `won[seat]` whether that seat's final
    /// score was the highest.
    pub fn learn(&mut self, prev: i32, moves: &[(usize, i32)], won: &[bool; SEAT_COUNT]) {
        let mut last = prev;
        for &(seat, mv) in moves {
            if last >= 0 {
                let slot = &mut self.reply[last as usize * SEAT_COUNT + seat];
                if won[seat] {
                    *slot = mv;
                } else if self.forget && *slot == mv {
                    *slot = -1;
                }
            }
            last = mv;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_winners_replies_and_forgets_losers() {
        let mut t = ReplyTable::new(true);
        // Seats 0..3 play 10, 11, 12, 13 after a game move 5. Seat 2 won.
        let moves = [(0, 10), (1, 11), (2, 12), (3, 13)];
        t.learn(5, &moves, &[false, false, true, false]);
        assert_eq!(t.get(2, 11), 12);
        assert_eq!(t.get(0, 5), -1);
        assert_eq!(t.get(1, 10), -1);
        // Seat 2 plays the same reply and loses: forgotten. A different losing reply leaves it.
        t.learn(5, &moves, &[true, false, false, false]);
        assert_eq!(t.get(0, 5), 10);
        assert_eq!(t.get(2, 11), -1);
        t.learn(5, &moves, &[false, false, true, false]);
        t.learn(5, &[(0, 10), (1, 11), (2, 99)], &[false; SEAT_COUNT]);
        assert_eq!(t.get(2, 11), 12);
        assert_eq!(t.get(0, 5), -1, "seat 0's reply to 5 was forgotten on its loss");
        // Without forgetting a loss changes nothing; ties count as won for every tied seat.
        let mut k = ReplyTable::new(false);
        k.learn(-1, &moves, &[true, true, false, false]);
        assert_eq!(k.get(0, 5), -1, "no previous placement: nothing stored for the first move");
        assert_eq!(k.get(1, 10), 11);
        k.learn(-1, &moves, &[false; SEAT_COUNT]);
        assert_eq!(k.get(1, 10), 11);
        k.clear();
        assert_eq!(k.get(1, 10), -1);
    }
}
