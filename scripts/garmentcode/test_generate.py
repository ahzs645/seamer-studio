"""Boundary validation and actual pinned-upstream geometry integration tests."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPT = Path(__file__).with_name("generate.py")
MODULE_SPEC = importlib.util.spec_from_file_location("garmentcode_bridge", SCRIPT)
bridge = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(bridge)


class BoundaryTests(unittest.TestCase):
    def test_rejects_duplicate_fields_and_non_finite_constants(self):
        for source in ['{"preset":"pants","preset":"dress"}', '{"body":{"bust":NaN}}']:
            with self.assertRaises(bridge.InputError):
                json.loads(source, object_pairs_hook=bridge.unique_object, parse_constant=bridge.reject_constant)

    def test_schema_cannot_be_changed_to_bypass_enum_or_range(self):
        schema = {"upper": {"v": "Shirt", "type": "select", "range": ["Shirt", "FittedShirt"]},
                  "width": {"v": 1.1, "type": "float", "range": [1.0, 1.3]}}
        for override in [{"upper": "os.system"}, {"upper": {"v": "os.system", "range": ["os.system"]}},
                         {"width": float("inf")}, {"width": 100}, {"width": True}, {"unknown": 1}]:
            with self.subTest(override=override), self.assertRaises(bridge.InputError):
                bridge.merge_design(schema, override)

    def test_rejects_unknown_top_level_fields_and_preset_types_before_runtime(self):
        for source in ['{"module":"os"}', '{"preset":[]}', '{"preset":"fake"}', '[]']:
            completed = subprocess.run([sys.executable, str(SCRIPT)], input=source, text=True, capture_output=True)
            self.assertEqual(completed.returncode, 2, completed.stderr)
            self.assertEqual(completed.stdout, "")


@unittest.skipUnless(os.environ.get("GARMENTCODE_ROOT"), "Configure trusted GARMENTCODE_ROOT for real generation")
class GenerationTests(unittest.TestCase):
    @classmethod
    def generate(cls, request):
        completed = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(request), text=True,
                                   capture_output=True, timeout=45)
        if completed.returncode:
            raise AssertionError(completed.stderr)
        spec = json.loads(completed.stdout)
        bridge.validate_pattern(spec)
        return spec

    def test_all_five_presets_generate_real_panels_and_stitches(self):
        for preset in bridge.PRESETS:
            with self.subTest(preset=preset):
                spec = self.generate({"preset": preset})
                self.assertGreaterEqual(len(spec["pattern"]["panels"]), 4)
                self.assertGreater(len(spec["pattern"]["stitches"]), 0)
                self.assertEqual(spec["properties"]["units_in_meter"], 100)
                self.assertAlmostEqual(spec["properties"]["garmentcode_body"]["height"], 171.99)
                self.assertAlmostEqual(spec["properties"]["garmentcode_body"]["arm_pose_angle"], 45.483)
                self.assertEqual(spec["properties"]["garmentcode_body_pose"],
                                 "apart" if preset == "pants" else "straight")
                # Every source edge lies on the directed loop, including curved edges.
                for panel in spec["pattern"]["panels"].values():
                    for index, edge in enumerate(panel["edges"]):
                        self.assertEqual(edge["endpoints"][1], panel["edges"][(index + 1) % len(panel["edges"])]["endpoints"][0])

    def test_body_measurements_and_design_change_geometry(self):
        baseline = self.generate({"preset": "t-shirt"})
        larger = self.generate({"preset": "t-shirt", "body": {"bust": 115, "waist": 100}})
        long_sleeves = self.generate({"preset": "t-shirt", "design": {"sleeve": {"length": {"v": 1.0}}}})
        self.assertNotEqual(baseline["pattern"]["panels"]["left_ftorso"]["vertices"],
                            larger["pattern"]["panels"]["left_ftorso"]["vertices"])
        self.assertEqual(larger["properties"]["garmentcode_body"]["bust"], 115)
        self.assertNotEqual(baseline["pattern"]["panels"]["left_sleeve_f"]["vertices"],
                            long_sleeves["pattern"]["panels"]["left_sleeve_f"]["vertices"])

    def test_waist_seamed_dress_defaults_to_waist_length_and_preserves_explicit_crop(self):
        request = {"preset": "dress", "body": {"height": 176, "bust": 101, "waist": 88, "hips": 106},
                   "design": {"sleeve": {"sleeveless": True}}}
        default = self.generate(request)
        explicit_waist = self.generate({**request, "design": {**request["design"], "shirt": {"length": 1.0}}})
        explicit_crop = self.generate({**request, "design": {**request["design"], "shirt": {"length": {"v": 0.8}}}})
        self.assertEqual(default["pattern"]["panels"], explicit_waist["pattern"]["panels"])
        growth_cm = 0.2 * default["properties"]["garmentcode_body"]["waist_line"]
        for name in ["left_ftorso", "right_ftorso", "left_btorso", "right_btorso"]:
            with self.subTest(panel=name):
                waist_panel = default["pattern"]["panels"][name]
                cropped_panel = explicit_crop["pattern"]["panels"][name]
                # The same source block gains torso length, without changing width.
                self.assertEqual([point[0] for point in waist_panel["vertices"]],
                                 [point[0] for point in cropped_panel["vertices"]])
                self.assertAlmostEqual(max(point[1] for point in waist_panel["vertices"])
                                       - max(point[1] for point in cropped_panel["vertices"]), growth_cm)
        self.assertEqual(len(default["pattern"]["panels"]), len(explicit_crop["pattern"]["panels"]))
        self.assertEqual(len(default["pattern"]["stitches"]), len(explicit_crop["pattern"]["stitches"]))

    def test_description_and_invalid_body_input(self):
        completed = subprocess.run([sys.executable, str(SCRIPT), "--describe"], text=True, capture_output=True, timeout=45)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        description = json.loads(completed.stdout)
        self.assertEqual(description["presets"], list(bridge.PRESETS))
        self.assertIn("bust", description["body"])
        for body in [{"_leg_length": 10}, {"bust": -1}, {"height": 10}, {"shoulder_incl": 500}]:
            completed = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps({"body": body}),
                                       text=True, capture_output=True, timeout=45)
            self.assertEqual(completed.returncode, 2, completed.stderr)
            self.assertEqual(completed.stdout, "")


if __name__ == "__main__":
    unittest.main()
