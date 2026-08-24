import socket
import unittest
import urllib.error

import model_retry


class ModelRetryPolicyTests(unittest.TestCase):
    def test_retries_transient_transport_and_capacity_errors(self):
        self.assertTrue(model_retry.is_retryable_model_error(TimeoutError()))
        self.assertTrue(model_retry.is_retryable_model_error(socket.timeout()))
        self.assertTrue(model_retry.is_retryable_model_error(
            urllib.error.HTTPError("https://example.test", 502, "bad gateway", {}, None)))
        self.assertTrue(model_retry.is_retryable_model_error(
            RuntimeError("模型返回空内容，未写入任何数据。")))

    def test_retries_configuration_and_terminal_response_errors_within_budget(self):
        self.assertTrue(model_retry.is_retryable_model_error(
            urllib.error.HTTPError("https://example.test", 401, "unauthorized", {}, None)))
        self.assertTrue(model_retry.is_retryable_model_error(
            RuntimeError("模型输出达到长度上限")))
        self.assertTrue(model_retry.is_retryable_model_error(
            RuntimeError("模型上游拒绝处理这张卡的内容")))

    def test_retry_budget_is_bounded(self):
        self.assertEqual(model_retry.MAX_MODEL_RETRIES, 5)
        self.assertEqual(model_retry.MAX_MODEL_ATTEMPTS, 6)
        self.assertEqual(model_retry.retry_delay_seconds(1), 1.0)
        self.assertEqual(model_retry.retry_delay_seconds(2), 2.0)
        self.assertEqual(model_retry.retry_delay_seconds(99), 2.0)


if __name__ == "__main__":
    unittest.main()
