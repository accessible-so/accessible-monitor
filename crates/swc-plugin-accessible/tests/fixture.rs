//! Fixture tests: every `tests/fixture/*/input.js` is transformed and compared
//! to the `output.js` beside it. To add a case, write the input and run the
//! suite once with `UPDATE=1` in the environment — without it the harness
//! reports a diff rather than writing the file. Read the generated `output.js`
//! before committing it: it records whatever the transform did, including
//! whatever it did wrong.
//!
//! The file name is fixed to `fixture/input.js` rather than taken from the
//! harness's temp path, so the stamped `data-a11y-source` is identical on
//! every machine.

use std::path::{Path, PathBuf};

use swc_core::ecma::parser::{EsSyntax, Syntax, TsSyntax};
use swc_core::ecma::transforms::testing::test_fixture;
use swc_core::ecma::visit::visit_mut_pass;
use swc_plugin_accessible::Stamper;

#[testing::fixture("tests/fixture/**/input.js")]
fn fixture(input: PathBuf) {
    run(
        Syntax::Es(EsSyntax {
            jsx: true,
            ..Default::default()
        }),
        "fixture/input.js",
        &input,
        "output.js",
    );
}

/// The TSX arm. The transform is shared, but the parser is not: the
/// TypeScript-transparent shapes in `stamp_expr` and a generic arrow component
/// cannot appear in a `.js` fixture at all, so without this arm they could
/// break and every test would still pass.
///
/// `as` and `satisfies` live here. The third shape, `!`, cannot: swc's printer
/// drops the parentheses around a non-null-asserted JSX element and its parser
/// then refuses to read `<b/>!` back, so no fixture for it can round-trip. It
/// is covered by a unit test in `lib.rs` instead.
///
/// `generic-arrow/output.tsx` is hand-corrected for the same reason and has to
/// stay that way. The harness re-parses the expected file, and the printer
/// emits a generic arrow's type parameter as `<T>` — which in a `.tsx` file is
/// the start of a JSX element, so the parser refuses it. TypeScript requires
/// the `<T,>` the input carries. `UPDATE=1` writes the printer's form and so
/// puts the break back; the comma has to be restored by hand. Both forms print
/// identically, and the comparison is on the printed form, so the fixture
/// still asserts exactly what the transform emits.
#[testing::fixture("tests/fixture-ts/**/input.tsx")]
fn fixture_ts(input: PathBuf) {
    run(
        Syntax::Typescript(TsSyntax {
            tsx: true,
            ..Default::default()
        }),
        "fixture/input.tsx",
        &input,
        "output.tsx",
    );
}

fn run(syntax: Syntax, stamped_as: &'static str, input: &Path, output_name: &str) {
    let output = input.parent().unwrap().join(output_name);
    test_fixture(
        syntax,
        &|tester| {
            let cm = tester.cm.clone();
            visit_mut_pass(Stamper::new(
                stamped_as.into(),
                // `try_` deliberately: `lookup_char_pos` is
                // `try_lookup_char_pos(pos).unwrap()`, and a miss here should
                // drop the line the way the plugin does, not blow up the test
                // with a panic from inside swc_common.
                Box::new(move |span| cm.try_lookup_char_pos(span.lo).ok().map(|loc| loc.line)),
            ))
        },
        input,
        &output,
        Default::default(),
    );
}
