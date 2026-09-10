"""Contract checks for the managed multilingual, text-only first greeting."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class GreetingTemplateTests(unittest.TestCase):
    def test_language_bodies_keep_current_content_and_community_links(self):
        prompt = (ROOT / "ops/installer/templates/greeting.md").read_text(encoding="utf-8")
        routing = prompt.split("## 完整正文", 1)[0]
        self.assertIn("agent_owner_locale", routing)
        self.assertIn("其他值或缺失时用英文", routing)
        self.assertIn("本轮不调用工具、不输出酒馆链接或卡片", routing)
        self.assertIn("保留正文中的社群链接", routing)
        self.assertLess(len(routing), 330)
        for locale in ("zh-Hant", "zh-TW", "zh-HK", "zh-MO"):
            self.assertIn(locale, routing)
        for obsolete in ("app-link", "Python", "HERMES_HOME", "## 用户选择之后", ".apps.clawling.io"):
            self.assertNotIn(obsolete, prompt)
        for language in ("简体中文", "繁體中文", "English"):
            heading = "### " + language
            self.assertEqual(prompt.count(heading), 1)
            body = prompt.split(heading, 1)[1].split("### ", 1)[0]
            self.assertIn("Tavern", body)
            self.assertIn("Story Profile", body)
            if language == "简体中文":
                self.assertIn("904830926", body)
                self.assertNotIn("discord.gg", body)
                self.assertIn("四格图标", body)
                self.assertIn("修改我的人设", body)
            else:
                self.assertIn("https://discord.gg/2fxP9uYvpV2", body)
                self.assertNotIn("904830926", body)
        self.assertIn("陈屿的苏州雨巷", prompt)
        self.assertIn("许清禾的厦门海风", prompt)
        self.assertIn("Chen Yu's Rainy Alleys of Suzhou", prompt)
        self.assertIn("Xu Qinghe's Sea Breeze in Xiamen", prompt)
        self.assertNotIn("Daniel", prompt)
        self.assertNotIn("Sophie", prompt)



if __name__ == "__main__":
    unittest.main()
